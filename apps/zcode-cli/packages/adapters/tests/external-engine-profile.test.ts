import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootTraceContext, type ExternalEngineSessionInput } from "@zcode/contracts";
import { createSharedZCodeCredentialStore } from "../src/auth/index.js";
import { resolveEngineConnection } from "../src/external-engine/connection-profile.js";
import type { AcpConnection } from "../src/external-engine/connection.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-engine-profile-"));
  roots.push(root);
  const env = {
    ZCODE_DATA_BASE_DIR: root,
    HOME: root,
    CODEX_HOME: "native-codex-home",
    APP_SERVER_LOGS: "raw-frames.log",
    OPENAI_API_KEY: "inherited-key",
    OPENAI_BASE_URL: "https://inherited-gateway.example/v1",
  };
  const key = "profile-private-key";
  const credentialKey = "external-engine:codex:profile-a";
  const store = createSharedZCodeCredentialStore({ env });
  await store.save(credentialKey, key);
  const profiles = [
    { id: "inherit", mode: "inherit" },
    {
      id: "profile-a",
      mode: "apiKey",
      credentialKey,
      hasApiKey: true,
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
    },
    { id: "profile-b", mode: "official" },
  ];
  await writeFile(
    join(root, "connections.json"),
    JSON.stringify({ activeProfileId: "profile-a", profiles }),
  );
  const input: ExternalEngineSessionInput = {
    sessionId: "local-session",
    engine: "codex",
    cwd: root,
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    onSession: async () => {},
    onConfigOptions: async () => {},
    onUpdate: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
  };
  return { root, env, input, key, store, profiles };
}

describe("Codex 连接身份隔离", () => {
  test("API Key 仅交给原生 provider 请求，普通配置与子进程环境不含密钥", async () => {
    const f = await fixture();
    const onConnectionProfile = vi.fn(async () => {});
    const resolved = await resolveEngineConnection(
      f.root,
      { ...f.input, onConnectionProfile },
      f.env,
    );
    expect(onConnectionProfile).toHaveBeenCalledWith("profile-a");
    expect(resolved.env.CODEX_HOME).toBe(join(f.root, "connections", "profile-a", "codex-home"));
    expect(resolved.env.HOME).toBe(f.env.HOME);
    expect(resolved.env.APP_SERVER_LOGS).toBeUndefined();
    expect(resolved.env.OPENAI_API_KEY).toBeUndefined();
    expect(resolved.env.OPENAI_BASE_URL).toBeUndefined();
    expect(resolved.env.CODEX_CONFIG).toBe('{"model":"model-a"}');
    const request = vi.fn(async () => ({}));
    await resolved.setup!({ request } as unknown as AcpConnection);
    expect(request).toHaveBeenCalledWith("providers/set", {
      providerId: "openai",
      apiType: "openai",
      baseUrl: "https://gateway.example/v1",
      headers: { Authorization: `Bearer ${f.key}` },
    });
    for (const path of [
      join(f.root, "connections.json"),
      join(resolved.env.CODEX_HOME!, "config.toml"),
      f.store.filePath,
    ]) {
      expect(await readFile(path, "utf8")).not.toContain(f.key);
    }
    expect(JSON.stringify(resolved.env)).not.toContain(f.key);
  });

  test("修改默认连接后旧会话仍保持原 profile，无绑定历史沿用用户原配置", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "connections.json"),
      JSON.stringify({ activeProfileId: "profile-b", profiles: f.profiles }),
    );
    const restored = await resolveEngineConnection(
      f.root,
      { ...f.input, externalSessionId: "native-history", connectionProfileId: "profile-a" },
      f.env,
    );
    expect(restored.profile.id).toBe("profile-a");
    expect(restored.env.CODEX_HOME).toContain("profile-a");
    const legacy = await resolveEngineConnection(
      f.root,
      { ...f.input, externalSessionId: "native-history" },
      f.env,
    );
    expect(legacy.profile.id).toBe("inherit");
    expect(legacy.env.CODEX_HOME).toBe(f.env.CODEX_HOME);
    const fresh = await resolveEngineConnection(f.root, f.input, f.env);
    expect(fresh.profile.id).toBe("profile-b");
    expect(fresh.env.OPENAI_BASE_URL).toBeUndefined();
    expect(legacy.env.OPENAI_BASE_URL).toBe(f.env.OPENAI_BASE_URL);
  });

  test("管理连接丢失时明确失败，不静默切换账号或默认网关", async () => {
    const f = await fixture();
    await expect(
      resolveEngineConnection(
        f.root,
        { ...f.input, connectionProfileId: "missing-profile" },
        f.env,
      ),
    ).rejects.toMatchObject({ failure: { code: "configuration" } });
    await f.store.delete("external-engine:codex:profile-a");
    await expect(resolveEngineConnection(f.root, f.input, f.env)).rejects.toMatchObject({
      failure: { code: "authentication" },
    });
  });
});
