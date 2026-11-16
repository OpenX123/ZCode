import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createPosixReleaseArchive } from "@zcode/server-cli/packaging";
import {
  createCacheRecoveryArchiveB,
  hashCacheRecoveryFile,
} from "./e2e/helpers/source-server-cache-lock-recovery-fixture.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cache recovery B public packaging boundary", () => {
  it("保留独立 SHA、marker 和旧版本，A/B 均具有安全的归档执行权限", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recovery-archive-test-"));
    roots.push(root);
    const releaseDir = join(root, "zcode-server-linux-x64");
    await mkdir(join(releaseDir, "bin"), { recursive: true });
    await mkdir(join(releaseDir, "runtime"), { recursive: true });
    await writeFile(join(releaseDir, "bin/zcode"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(releaseDir, "runtime/node"), "#!/bin/sh\nexit 0\n");
    await writeFile(
      join(releaseDir, "manifest.json"),
      JSON.stringify({ appVersion: "1.4.0", components: [{ id: "node-runtime" }] }),
    );
    const source =
      'var ZCODE_VERSION = true ? "1.4.0" : "dev"; var ZCODE_MIN_COMPATIBLE_VERSION = true ? "1.4.0" : "dev";';
    for (const file of ["server-core.js", "server-cli.js"])
      await writeFile(join(releaseDir, "runtime", file), source);
    // 普通文件即使在 POSIX 源上有过宽权限，最终 header 也不能继承为可执行。
    await chmod(join(releaseDir, "manifest.json"), 0o777);
    const archiveA = join(root, "a.tar.gz");
    await createPosixReleaseArchive({ releaseDir, archivePath: archiveA, layout: "release" });
    const aHash = await hashCacheRecoveryFile(archiveA);
    const archiveB = await createCacheRecoveryArchiveB({
      archiveA,
      artifactDir: root,
      oldVersion: "1.3.9",
    });
    expect(await hashCacheRecoveryFile(archiveA)).toBe(aHash);
    expect(await hashCacheRecoveryFile(archiveB)).not.toBe(aHash);
    const extract = join(root, "extracted");
    await mkdir(extract);
    await run("tar", ["-xzf", archiveB, "-C", extract]);
    const bRoot = join(extract, "zcode-server-linux-x64");
    expect(JSON.parse(await readFile(join(bRoot, "manifest.json"), "utf8"))).toEqual({
      appVersion: "1.3.9",
    });
    expect(await readFile(join(bRoot, "runtime/E2E_CACHE_RECOVERY_B.txt"), "utf8")).toBe(
      "E2E_CACHE_RECOVERY_B\n",
    );
    for (const file of ["server-core.js", "server-cli.js"]) {
      expect(await readFile(join(bRoot, "runtime", file), "utf8")).toBe(
        source.replaceAll("1.4.0", "1.3.9"),
      );
    }
    for (const archive of [archiveA, archiveB]) {
      const { stdout } = await run("tar", ["-tvzf", archive]);
      const lines = stdout.split(/\r?\n/u);
      for (const file of ["bin/zcode", "runtime/node"]) {
        expect(lines.find((line) => line.endsWith(`/${file}`))).toMatch(/^-rwxr-xr-x/u);
      }
      expect(lines.find((line) => line.endsWith("/manifest.json"))).toMatch(/^-rw-r--r--/u);
    }
  });

  it("拒绝 Windows release root 和输入根内输出，IO 失败正常传播", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recovery-archive-error-"));
    roots.push(root);
    await expect(
      createPosixReleaseArchive({
        releaseDir: join(root, "zcode-server-win32-x64"),
        archivePath: join(root, "out.tar.gz"),
        layout: "release",
      }),
    ).rejects.toThrow(/Invalid POSIX release root/u);
    await expect(
      createPosixReleaseArchive({
        releaseDir: root,
        archivePath: join(root, "out.tar.gz"),
        layout: "component",
      }),
    ).rejects.toThrow(/outside its input root/u);
    await expect(
      createPosixReleaseArchive({
        releaseDir: join(root, "missing"),
        archivePath: join(root, "out.tar.gz"),
        layout: "component",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const cancelledInput = join(root, "cancel-input");
    await mkdir(cancelledInput);
    await expect(
      createPosixReleaseArchive({
        releaseDir: cancelledInput,
        archivePath: join(root, "cancelled.tar.gz"),
        layout: "component",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
