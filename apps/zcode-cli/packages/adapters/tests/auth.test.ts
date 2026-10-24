import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/index.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "test-secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared ZCode credentials", () => {
  it("普通 MCP 凭据沿用加密文件、保存和恢复路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-"));
    try {
      const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
      await store.save("mcp:example:tokens", "mcp-user-token");
      const raw = JSON.parse(await readFile(store.filePath, "utf-8")) as Record<string, string>;
      expect(store.filePath).toBe(join(dir, ".zcode", "v2", "credentials.json"));
      expect(raw["mcp:example:tokens"]?.startsWith("enc:v1:")).toBe(true);
      const restored = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
      expect(await restored.load("mcp:example:tokens")).toBe("mcp-user-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("普通凭据变更不解密、不删除或改写旧官方凭据", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-preserve-retired-"));
    const filePath = join(dir, "credentials.json");
    const oldCredentials = {
      "oauth:zai:access_token": "opaque-retired-value",
      zcodejwttoken: "opaque-retired-jwt",
    };
    const decrypt = vi.fn((value: string) => value);
    try {
      await writeFile(filePath, JSON.stringify(oldCredentials));
      const store = createSharedZCodeCredentialStore({
        filePath,
        cipher: { decrypt, encrypt: (value) => value },
      });
      await store.save("mcp:example:tokens", "mcp-user-token");
      expect(await store.load("mcp:example:tokens")).toBe("mcp-user-token");
      await store.delete("mcp:example:tokens");
      expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual(oldCredentials);
      expect(decrypt).toHaveBeenCalledExactlyOnceWith("mcp-user-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads legacy plaintext credential values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-"));
    const credentialsDir = join(dir, ".zcode", "v2");
    const credentialsPath = join(credentialsDir, "credentials.json");

    try {
      await mkdir(credentialsDir, { recursive: true });
      await writeFile(
        credentialsPath,
        JSON.stringify({
          ["mcp:legacy:tokens"]: "legacy-token",
        }),
      );

      const store = createSharedZCodeCredentialStore({
        baseDir: dir,
        env: TEST_ENV,
      });

      expect(await store.load("mcp:legacy:tokens")).toBe("legacy-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves every key across concurrent read-modify-write mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-concurrent-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    const entries = Array.from({ length: 40 }, (_, index) => [`key-${index}`, `value-${index}`]);

    try {
      await Promise.all(entries.map(([key, value]) => store.save(key!, value!)));

      await Promise.all(
        entries.map(async ([key, value]) => {
          await expect(store.load(key!)).resolves.toBe(value);
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deletes a credential only when its expected plaintext value is still current", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-compare-delete-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await store.save("oauth:snapshot", "snapshot-a");

      await expect(store.deleteIfValue("oauth:snapshot", "stale-snapshot")).resolves.toBe(false);
      await expect(store.load("oauth:snapshot")).resolves.toBe("snapshot-a");
      await expect(store.deleteIfValue("oauth:snapshot", "snapshot-a")).resolves.toBe(true);
      await expect(store.load("oauth:snapshot")).resolves.toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("publishes a replacement credential and removes legacy keys in one mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-replace-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await store.save("oauth:legacy-client", "client-a");
      await store.save("oauth:legacy-tokens", "tokens-a");

      await store.saveReplacing("oauth:canonical", "pair-a", [
        "oauth:legacy-client",
        "oauth:legacy-tokens",
      ]);

      await expect(store.load("oauth:canonical")).resolves.toBe("pair-a");
      await expect(store.load("oauth:legacy-client")).resolves.toBeNull();
      await expect(store.load("oauth:legacy-tokens")).resolves.toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves every key across independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-processes-"));
    const credentialsPath = join(dir, "credentials.json");
    const processCount = 4;
    const keysPerProcess = 8;

    try {
      await runConcurrentCredentialWorkers(credentialsPath, processCount, keysPerProcess);
      const store = createSharedZCodeCredentialStore({
        env: TEST_ENV,
        filePath: credentialsPath,
      });
      await Promise.all(
        Array.from({ length: processCount }, () =>
          Array.from({ length: keysPerProcess }, async (_, keyIndex) => {
            await expect(store.load(`worker-${processIndex}:key-${keyIndex}`)).resolves.toBe(
              `value-${processIndex}-${keyIndex}`,
            );
          }),
        ).flat(),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("backs up corrupt JSON and refuses to overwrite it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-corrupt-"));
    const credentialsPath = join(dir, "credentials.json");
    const store = createSharedZCodeCredentialStore({
      env: TEST_ENV,
      filePath: credentialsPath,
    });

    try {
      await writeFile(credentialsPath, "{not-json", {
        encoding: "utf-8",
        mode: 0o644,
      });

      await Promise.all(
        Array.from({ length: 8 }, () =>
          expect(store.load("safe-key")).rejects.toThrow("Shared ZCode credentials are corrupt"),
        ),
      );
      await expect(store.save("safe-key", "safe-value")).rejects.toThrow(
        "Shared ZCode credentials are corrupt",
      );
      await expect(readFile(credentialsPath, "utf-8")).resolves.toBe("{not-json");
      const backups = (await readdir(dir)).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
      await expect(readFile(join(dir, backups[0]!), "utf-8")).resolves.toBe("{not-json");
      if (process.platform !== "win32") {
        expect((await stat(join(dir, backups[0]!))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deduplicates corrupt credential backups across independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-corrupt-processes-"));
    const credentialsPath = join(dir, "credentials.json");

    try {
      await writeFile(credentialsPath, "{not-json", "utf-8");
      await runConcurrentCredentialWorkers(credentialsPath, 6, 0, "read-corrupt");

      const backups = (await readdir(dir)).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function runConcurrentCredentialWorkers(
  filePath: string,
  processCount: number,
  keysPerProcess: number,
  operation: "save" | "read-corrupt" = "save",
): Promise<void> {
  const workerUrl = new URL("./fixtures/shared-credentials-concurrent-process.ts", import.meta.url);
  const children = Array.from({ length: processCount }, () =>
    fork(workerUrl, {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );

  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) =>
              reject(new Error(`credential child exited early: ${code}`)),
            );
            child.on("message", (message: { type?: unknown }) => {
              if (message.type === "ready") resolve();
            });
          }),
      ),
    );

    const results = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0) reject(new Error(`credential child exited with code ${code}`));
          });
          child.on("message", (message: { error?: unknown; type?: unknown }) => {
            if (message.type === "done") resolve();
            if (message.type === "error") reject(new Error(String(message.error)));
          });
        }),
    );

    children.forEach((child, processIndex) => {
      child.send({
        filePath,
        keysPerProcess,
        operation,
        processIndex,
        type: "start",
      });
    });
    await Promise.all(results);
  } finally {
    for (const child of children) {
      if (child.connected) child.disconnect();
      child.kill();
    }
  }
}
