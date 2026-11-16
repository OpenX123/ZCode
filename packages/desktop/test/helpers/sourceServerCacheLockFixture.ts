import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import { resolveSourceServerReleaseAsset } from "../../src/host/sourceServerReleaseResolver.js";

/** 真正经过 descriptor 校验和中断回收分支，不为生产 Error 增加测试构造入口。 */
export async function interruptedCacheLockFixture() {
  const root = await mkdtemp(join(tmpdir(), "ycode-lock-recovery-"));
  const recovery = {
    kind: "source-server-cache-lock" as const,
    version: ZCODE_VERSION,
    target: "linux-x64" as const,
    sha256: "a".repeat(64),
  };
  const fileName = "zcode-server-linux-x64.tar.gz";
  const releaseDir = join(root, "releases", ZCODE_VERSION);
  const remoteCacheDir = join(root, "cache");
  const contentDir = join(
    remoteCacheDir,
    "source-server",
    ZCODE_VERSION,
    "linux-x64",
    recovery.sha256,
  );
  const lockDir = join(contentDir, `${fileName}.lock`);
  await mkdir(releaseDir, { recursive: true });
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(releaseDir, "source-server-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: ZCODE_VERSION,
      archives: [
        {
          target: "linux-x64",
          version: ZCODE_VERSION,
          fileName,
          sha256: recovery.sha256,
          sizeBytes: 1,
          urls: ["https://release.example.test/archive"],
        },
      ],
    }),
  );
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "exited-owner" }),
  );
  await writeFile(
    join(lockDir, ".reaping"),
    JSON.stringify({ pid: 2147483647, token: "exited-reaper" }),
  );
  const resolveRelease = () =>
    resolveSourceServerReleaseAsset(
      { platform: "linux", arch: "x64", installed: false },
      { mockCdnDir: root, remoteCacheDir },
      { kind: "docker", container: "isolated" },
      {
        fetch: async () => {
          throw new Error("must not fetch while interrupted lock remains");
        },
      },
    );
  const error = await resolveRelease().then(
    () => {
      throw new Error("expected cache lock error");
    },
    (cause: unknown) => cause,
  );
  return {
    root,
    remoteCacheDir,
    contentDir,
    lockDir,
    recovery,
    error,
    resolveRelease,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
