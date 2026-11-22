import type { DataDirMigrationResult } from "@zcode/shared/ycode-data-root";

export interface DataDirMigrationEnvironment {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
}

export interface EarlyDataDirMigrationReport {
  allowRename: boolean;
  /** 通过 YCODE_* 别名写回的 ZCODE_* 名称。 */
  appliedEnvAliases: string[];
  results: DataDirMigrationResult[];
}

export interface DataDirMigrationLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 环境变量指定的数据目录 / home 覆盖或 E2E 运行都视为隔离环境，不重命名真实数据。 */
export function isIsolatedDataDirEnvironment(env: Record<string, string | undefined>): boolean {
  return [
    "YCODE_DATA_BASE_DIR",
    "ZCODE_DATA_BASE_DIR",
    "YCODE_DESKTOP_HOME_DIR",
    "ZCODE_DESKTOP_HOME_DIR",
    "ZCODE_E2E_RUN_ID",
  ].some((key) => Boolean(env[key]?.trim()));
}

export function shouldAllowDataDirRename(input: DataDirMigrationEnvironment): boolean {
  if (isIsolatedDataDirEnvironment(input.env)) return false;
  if (input.isPackaged) return true;
  return input.env.YCODE_DATA_DIR_MIGRATION?.trim() === "1";
}

/** 去重保持顺序；空值忽略。Windows 路径大小写不敏感，按小写去重。 */
export function collectMigrationBaseDirs(
  candidates: ReadonlyArray<string | null | undefined>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim().replace(/[\\/]+$/, "");
    if (!trimmed) continue;
    const key = platform === "win32" ? trimmed.toLowerCase().replace(/\//g, "\\") : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
