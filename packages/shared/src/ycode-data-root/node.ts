/**
 * Node-only：YCode 用户级数据根解析与本机迁移执行。
 *
 * 使用同步 fs：解析被大量同步路径函数调用（getAppConfigDir 等），迁移必须在 Desktop main
 * 其它模块求值前完成，与既有 setting.json 早期读取（readFileSync）是同一约束。
 */
import { lstatSync, mkdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  chooseDataRootDirName,
  planDataDirMigration,
  YCODE_DATA_DIR_NAMES,
  type DataDirEntryKind,
  type DataDirMigrationPlan,
  type DataRootFlavor,
} from "./contract.js";

const resolvedDirNameCache = new Map<string, string>();

function existsFollowingLinks(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 返回 `.ycode` 或未迁移时的 `.zcode`（Beta 为 `-beta` 变体）。 */
export function resolveYCodeDataRootDirName(
  baseDir: string,
  flavor: DataRootFlavor = "stable",
): string {
  const cacheKey = `${flavor}\0${baseDir}`;
  const cached = resolvedDirNameCache.get(cacheKey);
  if (cached) return cached;
  const names = YCODE_DATA_DIR_NAMES[flavor];
  const nextExists = existsFollowingLinks(join(baseDir, names.next));
  const legacyExists = !nextExists && existsFollowingLinks(join(baseDir, names.legacy));
  const dirName = chooseDataRootDirName({ nextExists, legacyExists }, flavor);
  // 只缓存稳定结果：两者都不存在时可能马上被创建，不能把临时判断固定下来。
  // 迁移只发生在 Desktop main 早期，迁移后由 migrateLegacyDataDirSync 清空缓存。
  if (nextExists || legacyExists) resolvedDirNameCache.set(cacheKey, dirName);
  return dirName;
}

/** `<baseDir>/.ycode`，或未迁移时的 `<baseDir>/.zcode`。 */
export function resolveYCodeDataRoot(baseDir: string, flavor: DataRootFlavor = "stable"): string {
  return join(baseDir, resolveYCodeDataRootDirName(baseDir, flavor));
}

export function clearYCodeDataRootCache(): void {
  resolvedDirNameCache.clear();
}

export interface DataDirMigrationFs {
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean } | null;
  rename(from: string, to: string): void;
  mkdir(path: string): void;
  /** target 为链接内容：Windows junction 需绝对路径，POSIX 用相对目录名。 */
  symlink(target: string, path: string, type: "junction" | "dir"): void;
}

export const nodeDataDirMigrationFs: DataDirMigrationFs = {
  lstat(path) {
    try {
      return lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  rename: (from, to) => renameSync(from, to),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  symlink: (target, path, type) => symlinkSync(target, path, type),
};

export type DataDirMigrationOutcome =
  | "migrated"
  | "created"
  | "linked"
  | "unchanged"
  | "skipped"
  | "rolled-back"
  | "failed";

export interface DataDirMigrationResult {
  baseDir: string;
  flavor: DataRootFlavor;
  legacyPath: string;
  nextPath: string;
  plan: DataDirMigrationPlan;
  outcome: DataDirMigrationOutcome;
  /** 失败、跳过或回滚原因；不含用户数据。 */
  detail?: string;
}

export interface MigrateLegacyDataDirOptions {
  flavor?: DataRootFlavor;
  /** 仅在打包版且非隔离环境允许 rename；全新目录的创建与补链接不受此限制。 */
  allowRename: boolean;
  /** 两者都不存在时是否创建新目录与链接；Beta 只在已使用时处理，传 false。默认 true。 */
  createIfMissing?: boolean;
  platform?: NodeJS.Platform;
  fs?: DataDirMigrationFs;
}

function readEntryKind(fs: DataDirMigrationFs, path: string): DataDirEntryKind {
  const stat = fs.lstat(path);
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "link";
  return stat.isDirectory() ? "directory" : "other";
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

/**
 * 迁移 `<baseDir>/.zcode` → `<baseDir>/.ycode` 并在旧位置建链接。幂等；任一步失败都保持旧目录可用，
 * 不复制数据，因此不会产生两份。
 */
export function migrateLegacyDataDirSync(
  baseDir: string,
  options: MigrateLegacyDataDirOptions,
): DataDirMigrationResult {
  const flavor = options.flavor ?? "stable";
  const fs = options.fs ?? nodeDataDirMigrationFs;
  const platform = options.platform ?? process.platform;
  const names = YCODE_DATA_DIR_NAMES[flavor];
  const legacyPath = join(baseDir, names.legacy);
  const nextPath = join(baseDir, names.next);
  const base = { baseDir, flavor, legacyPath, nextPath };
  let plan: DataDirMigrationPlan;
  try {
    plan = planDataDirMigration({
      legacy: readEntryKind(fs, legacyPath),
      next: readEntryKind(fs, nextPath),
      allowRename: options.allowRename,
    });
  } catch (error) {
    return {
      ...base,
      plan: { action: "none", reason: "unexpected-entry" },
      outcome: "skipped",
      detail: describeError(error),
    };
  }
  // Windows junction 不需要管理员权限但要求绝对目标；POSIX 用相对名，home 整体搬迁后链接仍有效。
  const linkType = platform === "win32" ? "junction" : "dir";
  const linkTarget = platform === "win32" ? nextPath : names.next;
  const createLink = () => fs.symlink(linkTarget, legacyPath, linkType);

  try {
    switch (plan.action) {
      case "none":
        return {
          ...base,
          plan,
          outcome: plan.reason === "legacy-is-link" ? "unchanged" : "skipped",
        };
      case "link-only":
        createLink();
        return { ...base, plan, outcome: "linked" };
      case "create-and-link":
        if (options.createIfMissing === false) return { ...base, plan, outcome: "unchanged" };
        fs.mkdir(nextPath);
        createLink();
        return { ...base, plan, outcome: "created" };
      case "rename-and-link":
        break;
    }
  } catch (error) {
    // 创建/补链接失败不影响数据：新目录（若刚创建）为空，解析器仍按存在性选择。
    return { ...base, plan, outcome: "failed", detail: describeError(error) };
  } finally {
    clearYCodeDataRootCache();
  }

  try {
    // Windows 上其它进程（旧版 YCode/CLI）占用目录内文件时 rename 失败，即视为“有进程占用”而跳过。
    fs.rename(legacyPath, nextPath);
  } catch (error) {
    clearYCodeDataRootCache();
    return { ...base, plan, outcome: "skipped", detail: `rename failed: ${describeError(error)}` };
  }
  try {
    createLink();
    clearYCodeDataRootCache();
    return { ...base, plan, outcome: "migrated" };
  } catch (linkError) {
    const linkDetail = `link failed: ${describeError(linkError)}`;
    try {
      // 没有链接时旧版 CLI 与写死旧路径的代码会另建 .zcode；回滚保持单份数据与旧行为。
      fs.rename(nextPath, legacyPath);
      return { ...base, plan, outcome: "rolled-back", detail: linkDetail };
    } catch (rollbackError) {
      return {
        ...base,
        plan,
        outcome: "failed",
        detail: `${linkDetail}; rollback failed: ${describeError(rollbackError)}`,
      };
    }
  } finally {
    clearYCodeDataRootCache();
  }
}
