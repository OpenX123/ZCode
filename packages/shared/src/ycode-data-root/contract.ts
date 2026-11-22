/**
 * YCode 用户级数据根的纯契约：目录名、迁移决策与 YCODE_* 环境变量别名。
 * 规则来源：docs/desktop/ycode-data-dir-migration.md。
 */

export type DataRootFlavor = "stable" | "beta";

export const YCODE_DATA_DIR_NAMES: Readonly<
  Record<DataRootFlavor, { readonly next: string; readonly legacy: string }>
> = {
  stable: { next: ".ycode", legacy: ".zcode" },
  beta: { next: ".ycode-beta", legacy: ".zcode-beta" },
};

/** 文件系统条目的 lstat 投影；link 包括 POSIX symlink 与 Windows junction。 */
export type DataDirEntryKind = "missing" | "directory" | "link" | "other";

/**
 * 解析顺序：新目录存在 → 新目录；仅旧目录存在（未迁移）→ 旧目录；都不存在 → 新目录。
 */
export function chooseDataRootDirName(
  input: { nextExists: boolean; legacyExists: boolean },
  flavor: DataRootFlavor = "stable",
): string {
  const names = YCODE_DATA_DIR_NAMES[flavor];
  if (input.nextExists) return names.next;
  return input.legacyExists ? names.legacy : names.next;
}

export type DataDirMigrationPlan =
  | { action: "rename-and-link" }
  | { action: "create-and-link" }
  | { action: "link-only" }
  | {
      action: "none";
      reason: "legacy-is-link" | "rename-not-allowed" | "both-directories" | "unexpected-entry";
    };

export function planDataDirMigration(input: {
  legacy: DataDirEntryKind;
  next: DataDirEntryKind;
  allowRename: boolean;
}): DataDirMigrationPlan {
  const { legacy, next } = input;
  // 旧位置已是链接：已迁移（或用户自建链接），任何改动都可能破坏现有指向。
  if (legacy === "link") return { action: "none", reason: "legacy-is-link" };
  if (legacy === "directory" && next === "missing") {
    return input.allowRename
      ? { action: "rename-and-link" }
      : { action: "none", reason: "rename-not-allowed" };
  }
  // 全新目录也建好新目录与旧位置链接：写死旧路径的代码不会另建一份真实 .zcode。
  if (legacy === "missing" && next === "missing") return { action: "create-and-link" };
  // 只有真实的新目录才补链接；新位置若是链接（如远端反向链接）补链接会形成环。
  if (legacy === "missing" && next === "directory") return { action: "link-only" };
  if (legacy === "directory" && (next === "directory" || next === "link")) {
    return { action: "none", reason: "both-directories" };
  }
  return { action: "none", reason: "unexpected-entry" };
}

/** 用户可配置的路径/模式类变量；YCODE_ 名称优先，旧 ZCODE_ 名称继续生效。 */
export const YCODE_ENV_ALIAS_NAMES = [
  "DATA_BASE_DIR",
  "STORAGE_DIR",
  "SESSION_DB_PATH",
  "HOME",
  "BETA",
  "ENV",
  "DESKTOP_HOME_DIR",
  "DESKTOP_USER_DATA_DIR",
  "DESKTOP_SESSION_DATA_DIR",
  "SERVER_RUNTIME_ROOT",
] as const;

export type YCodeEnvAliasName = (typeof YCODE_ENV_ALIAS_NAMES)[number];

/** ENV 在 Desktop 中是编译期身份，不写回 ZCODE_ENV，只在需要的位置经 readYCodeEnv 读取。 */
const NON_PROPAGATED_ALIAS_NAMES: ReadonlySet<YCodeEnvAliasName> = new Set(["ENV"]);

type EnvRecord = Record<string, string | undefined>;

export function readYCodeEnv(env: EnvRecord, name: YCodeEnvAliasName): string | undefined {
  return env[`YCODE_${name}`]?.trim() || env[`ZCODE_${name}`]?.trim() || undefined;
}

/**
 * 进程入口调用：把已设置的 YCODE_X 写入 ZCODE_X。既有读取点与子进程只认 ZCODE_ 名称，
 * 一次写回即可让两种名称同时生效，不必逐个改读取点。返回实际写回的名称。
 */
export function applyYCodeEnvAliases(env: EnvRecord): YCodeEnvAliasName[] {
  const applied: YCodeEnvAliasName[] = [];
  for (const name of YCODE_ENV_ALIAS_NAMES) {
    if (NON_PROPAGATED_ALIAS_NAMES.has(name)) continue;
    const value = env[`YCODE_${name}`]?.trim();
    if (!value) continue;
    env[`ZCODE_${name}`] = value;
    applied.push(name);
  }
  return applied;
}
