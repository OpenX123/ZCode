import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";
import type {
  OfficialPluginDigestSource,
  OfficialPluginFileDigest,
  OfficialPluginFileStat,
  ResolveOfficialPluginFileDigestsInput,
} from "./contract.js";

/**
 * 文件系统来源的内置插件摘要缓存（规则见 docs/design/v2/plugin-compat.md「内置插件摘要缓存」）。
 *
 * 修复原因：每次建会话 app 都要 seed 内置插件，过去 seed 前同步重读并 SHA-256 全部内置插件文件
 * （1.0.5 生产日志：会话 app 插件阶段 p50 0.8s / p90 1.4s，约 42MB / 600 个文件），并占用 CLI
 * 单线程。内置插件随应用版本不可变：同一进程只计算一次；跨进程按"应用版本 + 文件统计签名"
 * 复用持久化的摘要，签名一致时不再读取文件内容。复制进缓存时仍逐文件校验 SHA-256。
 */
interface OfficialPluginStatSignature {
  fileCount: number;
  maxMtimeMs: number;
  /** 逐文件 path / size / mtime / mode 的摘要：同大小、同最大 mtime 的替换也能被识别。 */
  statDigest: string;
  totalSize: number;
}

interface StoredDigestEntry {
  appVersion: string;
  files: Array<{ path: string; sha256: string }>;
  pluginName: string;
  pluginVersion: string;
  rootPath: string;
  savedAt: number;
  signature: OfficialPluginStatSignature;
}

interface DigestStoreFile {
  entries: Record<string, StoredDigestEntry>;
  version: typeof DIGEST_STORE_VERSION;
}

const DIGEST_STORE_FILE = "official-plugin-digests.json";
const DIGEST_STORE_VERSION = 1;
// 每个应用版本约十几个内置插件；保留若干个版本即可覆盖稳定版与预览版共存，超出按保存时间淘汰。
const MAX_DIGEST_STORE_ENTRIES = 64;
const UNKNOWN_APP_VERSION = "unknown";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

// 进程内记忆：内置插件在一个应用版本内不可变，开发态改动插件后按既有约定重启生效。
const digestMemo = new Map<string, OfficialPluginFileDigest[]>();
// 持久化文件只在进程内首次未命中记忆时读取；同一进程后续只读内存副本。
const loadedStores = new Map<string, DigestStoreFile>();

export function resolveOfficialPluginFileDigests(input: ResolveOfficialPluginFileDigestsInput): {
  files: OfficialPluginFileDigest[];
  source: OfficialPluginDigestSource;
} {
  const appVersion = input.appVersion?.trim() || UNKNOWN_APP_VERSION;
  const memoKey = [appVersion, input.rootPath, input.definition.name, input.definition.version].join(
    "\0",
  );
  const memoized = digestMemo.get(memoKey);
  if (memoized) return { files: memoized, source: "memory" };

  const stats = input.listFiles();
  const signature = computeStatSignature(stats);
  const storePath = join(input.storageRoot, DIGEST_STORE_FILE);
  const entryKey = createHash("sha256").update(memoKey).digest("hex");
  const stored = loadStore(storePath).entries[entryKey];
  const reused =
    stored &&
    stored.appVersion === appVersion &&
    stored.rootPath === input.rootPath &&
    stored.pluginName === input.definition.name &&
    stored.pluginVersion === input.definition.version &&
    signaturesEqual(stored.signature, signature)
      ? attachStoredDigests(stats, stored.files)
      : undefined;
  if (reused) {
    digestMemo.set(memoKey, reused);
    return { files: reused, source: "persisted" };
  }

  const files = stats.map((stat) => ({
    mode: stat.mode,
    path: stat.path,
    sha256: input.hashFile(stat),
    sourcePath: stat.sourcePath,
  }));
  writeStoreEntry(
    storePath,
    entryKey,
    {
      appVersion,
      files: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      pluginName: input.definition.name,
      pluginVersion: input.definition.version,
      rootPath: input.rootPath,
      savedAt: Date.now(),
      signature,
    },
    input.logger,
  );
  digestMemo.set(memoKey, files);
  return { files, source: "hashed" };
}

function computeStatSignature(stats: readonly OfficialPluginFileStat[]): OfficialPluginStatSignature {
  const digest = createHash("sha256");
  let totalSize = 0;
  let maxMtimeMs = 0;
  for (const stat of stats) {
    totalSize += stat.size;
    maxMtimeMs = Math.max(maxMtimeMs, stat.mtimeMs);
    digest.update(`${stat.path}\0${stat.size}\0${stat.mtimeMs}\0${stat.mode}\n`);
  }
  return { fileCount: stats.length, maxMtimeMs, statDigest: digest.digest("hex"), totalSize };
}

function signaturesEqual(
  left: OfficialPluginStatSignature,
  right: OfficialPluginStatSignature,
): boolean {
  return (
    left.fileCount === right.fileCount &&
    left.totalSize === right.totalSize &&
    left.maxMtimeMs === right.maxMtimeMs &&
    left.statDigest === right.statDigest
  );
}

/** 签名一致意味着路径集合一致；这里仍逐项核对路径，任何错位都按未命中重新哈希。 */
function attachStoredDigests(
  stats: readonly OfficialPluginFileStat[],
  stored: ReadonlyArray<{ path: string; sha256: string }>,
): OfficialPluginFileDigest[] | undefined {
  if (stored.length !== stats.length) return undefined;
  const files: OfficialPluginFileDigest[] = [];
  for (const [index, stat] of stats.entries()) {
    const entry = stored[index];
    if (!entry || entry.path !== stat.path || !SHA256_HEX.test(entry.sha256)) return undefined;
    files.push({ mode: stat.mode, path: stat.path, sha256: entry.sha256, sourcePath: stat.sourcePath });
  }
  return files;
}

function loadStore(storePath: string): DigestStoreFile {
  const loaded = loadedStores.get(storePath);
  if (loaded) return loaded;
  const store = readStoreFromDisk(storePath);
  loadedStores.set(storePath, store);
  return store;
}

function readStoreFromDisk(storePath: string): DigestStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Partial<DigestStoreFile>;
    if (parsed.version !== DIGEST_STORE_VERSION || !isRecord(parsed.entries)) return emptyStore();
    const entries: Record<string, StoredDigestEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (isStoredDigestEntry(value)) entries[key] = value;
    }
    return { entries, version: DIGEST_STORE_VERSION };
  } catch {
    // 缺失、损坏或并发写入中的文件都只是缓存未命中，按重新哈希处理。
    return emptyStore();
  }
}

function writeStoreEntry(
  storePath: string,
  entryKey: string,
  entry: StoredDigestEntry,
  logger: Logger | undefined,
): void {
  // 多个 workspace Agent 会并发写同一文件：先合并磁盘上的最新内容再整体原子替换，
  // 最坏情况只是丢掉另一进程刚写的条目，下次未命中时重新哈希即可收敛。
  const latest = readStoreFromDisk(storePath);
  const entries = { ...latest.entries, [entryKey]: entry };
  const kept = Object.entries(entries)
    .sort(([, left], [, right]) => right.savedAt - left.savedAt)
    .slice(0, MAX_DIGEST_STORE_ENTRIES);
  const next: DigestStoreFile = { entries: Object.fromEntries(kept), version: DIGEST_STORE_VERSION };
  loadedStores.set(storePath, next);
  const temporaryPath = `${storePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(next)}\n`, "utf8");
    renameSync(temporaryPath, storePath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // 临时文件名唯一，清理失败不会影响后续读取。
    }
    logger?.warn("Official plugin digest cache write failed", {
      errorCode: (error as NodeJS.ErrnoException).code,
      event: "bootstrap.official_plugin_digest.write_failed",
      module: "bootstrap.official_plugin_cache",
      status: "failed",
    });
  }
}

function isStoredDigestEntry(value: unknown): value is StoredDigestEntry {
  if (!isRecord(value) || !isRecord(value.signature) || !Array.isArray(value.files)) return false;
  const signature = value.signature;
  return (
    typeof value.appVersion === "string" &&
    typeof value.pluginName === "string" &&
    typeof value.pluginVersion === "string" &&
    typeof value.rootPath === "string" &&
    typeof value.savedAt === "number" &&
    typeof signature.fileCount === "number" &&
    typeof signature.maxMtimeMs === "number" &&
    typeof signature.statDigest === "string" &&
    typeof signature.totalSize === "number" &&
    value.files.every(
      (file) => isRecord(file) && typeof file.path === "string" && typeof file.sha256 === "string",
    )
  );
}

function emptyStore(): DigestStoreFile {
  return { entries: {}, version: DIGEST_STORE_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
