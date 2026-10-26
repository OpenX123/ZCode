import { normalizeRemoteConnectionError } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ZCODE_VERSION,
  normalizeRemoteAssetInstallMode,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";
import {
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";
import type { ServerReleaseAsset, SourceServerProbeResult } from "@zcode/server/source-server";
import type { WindowRemoteAssetDirs } from "./windowRemoteConnectionRegistry.js";

const ARCHIVE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const LOCK_WAIT_TIMEOUT_MS = 6 * 60_000;
const ORPHAN_LOCK_TIMEOUT_MS = 60_000;

interface ResolveOptions {
  metadataOnly?: boolean;
  signal?: AbortSignal;
}

interface ResolvedDescriptor {
  descriptor: SourceServerReleaseDescriptor;
  releaseBases: string[];
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  try {
    return (await sha256File(path)) === archive.sha256;
  } catch (error) {
    // 另一个持锁 Host 可能正在移除损坏缓存；校验期间消失与未命中等价。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== ZCODE_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${ZCODE_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

function resolveArchiveUrls(releaseBases: string[], archive: SourceServerReleaseArchive): string[] {
  const absolute = archive.urls.filter((url) => /^https?:\/\//u.test(url));
  const relative = archive.urls.filter((url) => !/^https?:\/\//u.test(url));
  return Array.from(
    new Set([
      ...buildReleaseAssetUrlCandidates(releaseBases, [archive.fileName, ...relative]),
      ...absolute,
    ]),
  );
}

async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

async function resolveRemoteDescriptor(
  remoteAssets: WindowRemoteAssetDirs,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  signal?: AbortSignal,
): Promise<ResolvedDescriptor> {
  const releaseBases = buildReleaseBaseCandidates(
    remoteAssets.remoteCdnBaseUrls ??
      (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : []),
    ZCODE_VERSION,
  );
  const descriptorUrls = buildReleaseAssetUrlCandidates(releaseBases, [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ]);
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of descriptorUrls) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text);
      return { descriptor, releaseBases };
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    }
  }
  throw new Error("Unable to resolve Source Server release descriptor", { cause: lastError });
}

async function readLockOwner(
  lockDir: string,
  fileName = "owner.json",
): Promise<{ pid: number; token: string } | null> {
  try {
    const owner = JSON.parse(await readFile(join(lockDir, fileName), "utf8"));
    return Number.isSafeInteger(owner.pid) && typeof owner.token === "string" ? owner : null;
  } catch {
    return null;
  }
}

function isExitedProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function reclaimExitedLock(lockDir: string): Promise<void> {
  const owner = await readLockOwner(lockDir);
  const modified = await stat(lockDir).catch(() => null);
  if (
    owner
      ? !isExitedProcess(owner.pid)
      : !modified || Date.now() - modified.mtimeMs < ORPHAN_LOCK_TIMEOUT_MS
  )
    return;
  // 失联 Host 的锁不能永久阻塞后续连接；回收标记保证多个等待者不会删掉后来者的新锁。
  const reaperPath = join(lockDir, ".reaping");
  const reaper = await open(reaperPath, "wx").catch(() => null);
  if (!reaper) {
    const previousReaper = await readLockOwner(lockDir, ".reaping");
    const marker = await stat(reaperPath).catch(() => null);
    const interrupted = previousReaper
      ? isExitedProcess(previousReaper.pid)
      : marker && Date.now() - marker.mtimeMs >= ORPHAN_LOCK_TIMEOUT_MS;
    const current = await readLockOwner(lockDir);
    if (
      interrupted &&
      (owner ? current?.token === owner.token && isExitedProcess(owner.pid) : !current)
    ) {
      // 回收者本身也可能崩溃；直接报告可恢复错误，不能永久轮询或争抢删除标记误伤新锁。
      throw new Error(`远程资源缓存锁回收中断；请删除锁目录后重试：${lockDir}`);
    }
    return;
  }
  const retiredLockDir = `${lockDir}.${randomUUID()}.stale`;
  try {
    await reaper.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
    const current = await readLockOwner(lockDir);
    if (owner ? current?.token !== owner.token || !isExitedProcess(owner.pid) : current !== null)
      return;
    // 先原子移走失效锁，再只清理旧目录；新持有者创建同名锁后不会被 finally 误删。
    await rename(lockDir, retiredLockDir);
  } finally {
    await reaper.close();
    await rm(retiredLockDir, { recursive: true, force: true });
  }
}

async function acquireArchiveLock(
  cached: string,
  archive: SourceServerReleaseArchive,
  signal?: AbortSignal,
): Promise<(() => Promise<void>) | null> {
  const lockDir = `${cached}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    signal?.throwIfAborted();
    if (await verifyArchive(cached, archive)) return null;
    try {
      await mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reclaimExitedLock(lockDir);
      if (Date.now() >= deadline)
        throw new Error(`Source Server archive lock timed out: ${archive.fileName}`);
      await delay(50, undefined, { signal });
      continue;
    }
    try {
      await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      if ((await readLockOwner(lockDir))?.token === token)
        await rm(lockDir, { recursive: true, force: true });
    };
  }
}

async function downloadArchive(
  archive: SourceServerReleaseArchive,
  urls: string[],
  cacheRoot: string,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  signal?: AbortSignal,
): Promise<string> {
  const contentDir = join(cacheRoot, archive.target, archive.sha256);
  await mkdir(contentDir, { recursive: true });
  const cached = join(contentDir, archive.fileName);
  const releaseLock = await acquireArchiveLock(cached, archive, signal);
  if (!releaseLock) return cached;
  try {
    // 等锁期间另一 Host 可能已完成提交，取得锁后再次校验，避免重复下载。
    if (await verifyArchive(cached, archive)) return cached;
    // 同版本构建曾共用缓存文件名，重发时可能互相覆盖；锁与提交路径均绑定目标和内容 SHA。
    await rm(cached, { force: true });
    let lastError: unknown;
    const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
    for (const url of urls) {
      const temporary = `${cached}.${process.pid}.${randomUUID()}.tmp`;
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]);
      try {
        requestSignal.throwIfAborted();
        const response = await fetchImpl(url, { signal: requestSignal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        await pipeline(
          Readable.fromWeb(response.body as never),
          createWriteStream(temporary, { mode: 0o600 }),
          { signal: requestSignal },
        );
        if (!(await verifyArchive(temporary, archive))) {
          throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
        }
        signal?.throwIfAborted();
        await rename(temporary, cached);
        return cached;
      } catch (error) {
        lastError = error;
        await rm(temporary, { force: true }).catch(() => undefined);
        signal?.throwIfAborted();
      }
    }
    throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
      cause: lastError,
    });
  } finally {
    await releaseLock();
  }
}

export async function resolveSourceServerReleaseAsset(
  ...args: Parameters<typeof resolveReleaseAsset>
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(...args);
  } catch (error) {
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}

async function resolveReleaseAsset(
  probe: SourceServerProbeResult,
  remoteAssets: WindowRemoteAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  options: ResolveOptions = {},
): Promise<ServerReleaseAsset> {
  options.signal?.throwIfAborted();
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    throw new Error(`Unsupported Source Server release target: ${probe.platform}-${probe.arch}`);
  }
  const target = `${probe.platform}-${probe.arch}`;
  const installMode =
    remoteTarget.kind === "ssh"
      ? normalizeRemoteAssetInstallMode(remoteTarget.assetInstallMode)
      : "local-download-upload";
  const cacheRoot = remoteAssets.remoteCacheDir
    ? join(remoteAssets.remoteCacheDir, "source-server", ZCODE_VERSION)
    : null;
  const hasExplicitMirror = (
    remoteAssets.remoteCdnBaseUrls ??
    (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : [])
  ).some((baseUrl) => baseUrl.trim().length > 0);

  if (
    remoteTarget.kind === "ssh" &&
    remoteAssets.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!remoteAssets.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // Bug 原因：开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      // 内容寻址开发策略只能消费本轮本地 descriptor/archive，缺失时必须明确失败。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: ZCODE_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  let resolvedDescriptor: ResolvedDescriptor | undefined;
  if (remoteAssets.mockCdnDir) {
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION);
    const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
    if (await pathExists(descriptorPath)) {
      const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
      const archive = findArchive(descriptor, target);
      const archivePath = join(releaseDir, archive.fileName);
      if (await pathExists(archivePath)) {
        if (!(await verifyArchive(archivePath, archive))) {
          throw new Error(
            `Source Server local archive failed descriptor verification: ${archivePath}`,
          );
        }
        return {
          localArchivePath: archivePath,
          target,
          version: ZCODE_VERSION,
          sha256: archive.sha256,
          sizeBytes: archive.sizeBytes,
          urls: archive.urls,
        };
      }
      resolvedDescriptor = {
        descriptor,
        releaseBases: buildReleaseBaseCandidates(
          remoteAssets.remoteCdnBaseUrls ??
            (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : []),
          ZCODE_VERSION,
        ),
      };
    }
  }
  // 只有随包清单或用户显式镜像可决定来源，旧缓存 descriptor 不能恢复已退役下载地址。
  if (!resolvedDescriptor) {
    if (!hasExplicitMirror) {
      throw new Error("Source Server 本地产物缺失；请安装本仓库完整构建或配置资源镜像");
    }
    resolvedDescriptor = await resolveRemoteDescriptor(
      remoteAssets,
      remoteAssetNetwork,
      options.signal,
    );
  }
  const archive = findArchive(resolvedDescriptor.descriptor, target);
  const urls = resolveArchiveUrls(resolvedDescriptor.releaseBases, archive);
  if (urls.length === 0)
    throw new Error(`Source Server descriptor has no downloadable URL: ${archive.fileName}`);
  if (installMode === "remote-download" || options.metadataOnly) {
    return {
      target,
      version: ZCODE_VERSION,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      urls,
    };
  }
  if (!cacheRoot)
    throw new Error(`Source Server release cache is unavailable: ${archive.fileName}`);
  return {
    localArchivePath: await downloadArchive(
      archive,
      urls,
      cacheRoot,
      remoteAssetNetwork,
      options.signal,
    ),
    target,
    version: ZCODE_VERSION,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls,
  };
}
