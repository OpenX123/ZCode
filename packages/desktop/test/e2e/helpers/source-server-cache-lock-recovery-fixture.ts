import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sourceServerReleaseDescriptorSchema } from "@zcode/shared";

const run = promisify(execFile);
export type CacheRecoveryMarker = "exited-reaper" | "aged-empty-reaper";

export async function hashCacheRecoveryFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function exitedFixturePid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveExit() : reject(new Error("fixture 子进程失败")),
    );
  });
  if (!pid) throw new Error("fixture 子进程没有 PID");
  try {
    process.kill(pid, 0);
    throw new Error("fixture PID 尚未退出");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return pid;
}

/** B 来自本轮真实 A runtime；只改变版本元数据与固定 marker，不模拟旧版业务实现。 */
export async function createCacheRecoveryArchiveB(options: {
  archiveA: string;
  artifactDir: string;
  oldVersion?: string;
}): Promise<string> {
  await mkdir(options.artifactDir, { recursive: true });
  const work = await mkdtemp(join(options.artifactDir, "cache-recovery-archive-"));
  const listing = await run("tar", ["-tzf", options.archiveA], { maxBuffer: 1 << 24 });
  const top = listing.stdout
    .split("\n")
    .find((line) => line.trim())
    ?.split("/")[0];
  if (!top || top === "." || top === "..") throw new Error("fixture archive 顶层无效");
  await run("tar", ["-xzf", options.archiveA, "-C", work], { timeout: 300_000 });
  await writeFile(join(work, top, "runtime/E2E_CACHE_RECOVERY_B.txt"), "E2E_CACHE_RECOVERY_B\n");
  if (options.oldVersion) {
    const manifestPath = join(work, top, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.appVersion = options.oldVersion;
    delete manifest.components;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    for (const file of ["server-core.js", "server-cli.js"]) {
      const path = join(work, top, "runtime", file);
      let count = 0;
      let source = await readFile(path, "utf8");
      source = source.replace(/(ZCODE_VERSION\d* = true \? )"[^"]+"/gu, (_match, prefix) => {
        count += 1;
        return prefix + JSON.stringify(options.oldVersion);
      });
      if (!count) throw new Error("fixture 未找到编译版本常量");
      source = source.replace(
        /(ZCODE_MIN_COMPATIBLE_VERSION\d* = true \? )"[^"]+"/gu,
        (_match, prefix) => prefix + JSON.stringify(options.oldVersion),
      );
      await writeFile(path, source);
    }
  }
  const archiveB = join(options.artifactDir, `cache-recovery-b-${randomUUID()}.tar.gz`);
  await run("tar", ["-czf", archiveB, "-C", work, top], { timeout: 300_000 });
  await rm(work, { recursive: true, force: true });
  return archiveB;
}

/** 严格绑定当前 run 的 A/B 内容地址；产品运行期间只读，唯一删除动作供退出屏障回调调用。 */
export async function createSourceServerCacheLockRecoveryFixture(options: {
  cacheRoot: string;
  releaseRoot: string;
  archiveB: string;
  target: string;
  marker: CacheRecoveryMarker;
}) {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(join(options.releaseRoot, "source-server-release.json"), "utf8")),
  );
  const entry = descriptor.archives.find((item) => item.target === options.target);
  if (!entry) throw new Error("fixture 缺少真实 probe target");
  const version = descriptor.version;
  const sourceArchive = join(options.releaseRoot, entry.fileName);
  const sourceSha = await hashCacheRecoveryFile(sourceArchive);
  if (sourceSha !== entry.sha256) throw new Error("fixture A 与本轮 descriptor 不匹配");
  const bSha = await hashCacheRecoveryFile(options.archiveB);
  if (bSha === entry.sha256) throw new Error("fixture 必须具有不同的两个 SHA");
  const root = resolve(options.cacheRoot);
  const aParent = join(root, "source-server", version, entry.target, entry.sha256);
  const aArchive = join(aParent, entry.fileName);
  const aLock = `${aArchive}.lock`;
  const bParent = join(root, "source-server", version, entry.target, bSha);
  const bArchive = join(bParent, entry.fileName);
  const bLock = `${bArchive}.lock`;
  await mkdir(aLock, { recursive: true });
  await mkdir(bLock, { recursive: true });
  if (await stat(aArchive).catch(() => null)) throw new Error("fixture A 已存在，会绕过锁");
  const owner = Buffer.from(JSON.stringify({ pid: await exitedFixturePid(), token: randomUUID() }));
  const reaper =
    options.marker === "exited-reaper"
      ? Buffer.from(JSON.stringify({ pid: await exitedFixturePid(), token: randomUUID() }))
      : Buffer.alloc(0);
  const bOwner = Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID() }));
  await writeFile(join(aLock, "owner.json"), owner);
  await writeFile(join(aLock, ".reaping"), reaper);
  if (options.marker === "aged-empty-reaper") {
    const old = new Date(Date.now() - 120_000);
    await utimes(join(aLock, ".reaping"), old, old);
  }
  await writeFile(join(bLock, "owner.json"), bOwner);
  await writeFile(join(bLock, ".reaping"), "E2E_CACHE_RECOVERY_B_REAPER\n");
  await copyFile(options.archiveB, bArchive);
  const aCanonical = await realpath(aLock);
  const bReaper = await readFile(join(bLock, ".reaping"));
  let removedAfterExit = false;
  const assertBAndSourceUnchanged = async () => {
    if (
      !(await readFile(join(bLock, "owner.json"))).equals(bOwner) ||
      !(await readFile(join(bLock, ".reaping"))).equals(bReaper) ||
      (await hashCacheRecoveryFile(bArchive)) !== bSha ||
      (await hashCacheRecoveryFile(sourceArchive)) !== sourceSha
    ) {
      throw new Error("fixture B 或源 archive 被误改");
    }
  };
  const assertOriginalLocks = async () => {
    if (
      !(await readFile(join(aLock, "owner.json"))).equals(owner) ||
      !(await readFile(join(aLock, ".reaping"))).equals(reaper)
    ) {
      throw new Error("fixture A 锁原始字节被改写");
    }
    await assertBAndSourceUnchanged();
  };
  return {
    aParent,
    aArchive,
    aSha: entry.sha256,
    bSha,
    target: entry.target,
    version,
    assertOriginalLocks,
    assertBAndSourceUnchanged,
    async removeExactALockAfterExit() {
      if (removedAfterExit) throw new Error("fixture A 只能清理一次");
      await assertOriginalLocks();
      const current = await realpath(aLock);
      const relation = relative(await realpath(root), current);
      if (
        current !== aCanonical ||
        relation.startsWith("..") ||
        dirname(current) !== (await realpath(aParent))
      ) {
        throw new Error("fixture A canonical 归属改变，拒绝删除");
      }
      await rm(aLock, { recursive: true });
      removedAfterExit = true;
      await assertBAndSourceUnchanged();
    },
    async assertRecoveredArchive() {
      if (!removedAfterExit || (await hashCacheRecoveryFile(aArchive)) !== entry.sha256) {
        throw new Error("fixture A 没有在退出后恢复成 descriptor 内容");
      }
      await assertBAndSourceUnchanged();
    },
  };
}
