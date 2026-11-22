import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyYCodeEnvAliases,
  migrateLegacyDataDirSync,
  resolveYCodeDataRoot,
  type DataDirMigrationFs,
  type DataDirMigrationResult,
} from "@zcode/shared/ycode-data-root";
import {
  collectMigrationBaseDirs,
  shouldAllowDataDirRename,
  type DataDirMigrationLogger,
  type EarlyDataDirMigrationReport,
} from "./contract.js";

export interface RunEarlyDataDirMigrationOptions {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fs?: DataDirMigrationFs;
}

function readSettingsDataBaseDir(homeBase: string): string | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(resolveYCodeDataRoot(homeBase), "v2", "setting.json"), "utf-8"),
    ) as { dataBaseDir?: unknown };
    return typeof raw?.dataBaseDir === "string" && raw.dataBaseDir.trim()
      ? raw.dataBaseDir.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * 启动早期迁移：先迁移 home（setting.json 在 home 下），再读取迁移后的 setting.json，
 * 对自定义 dataBaseDir 执行同样规则。只做同步 rename/link，不复制数据。
 */
export function runEarlyDataDirMigration(
  options: RunEarlyDataDirMigrationOptions,
): EarlyDataDirMigrationReport {
  const env = options.env;
  const platform = options.platform ?? process.platform;
  const appliedEnvAliases = applyYCodeEnvAliases(env);
  const allowRename = shouldAllowDataDirRename({ env, isPackaged: options.isPackaged });
  const primaryHome = options.homeDir ?? homedir();
  const homeBases = collectMigrationBaseDirs(
    [primaryHome, ...(options.homeDir ? [] : [env.HOME, env.USERPROFILE])],
    platform,
  );
  const results: DataDirMigrationResult[] = [];
  const migrateBase = (baseDir: string) => {
    for (const flavor of ["stable", "beta"] as const) {
      // Beta 目录只在已存在时处理，不为未使用 Beta 的用户创建 .ycode-beta。
      const result = migrateLegacyDataDirSync(baseDir, {
        allowRename,
        flavor,
        createIfMissing: flavor === "stable",
        platform,
        fs: options.fs,
      });
      if (result.outcome !== "unchanged" || result.plan.action !== "create-and-link") {
        results.push(result);
      }
    }
  };
  for (const homeBase of homeBases) migrateBase(homeBase);

  const settingsBase = readSettingsDataBaseDir(primaryHome);
  const extraBases = collectMigrationBaseDirs([...homeBases, settingsBase], platform).slice(
    homeBases.length,
  );
  for (const baseDir of extraBases) migrateBase(baseDir);
  return { allowRename, appliedEnvAliases, results };
}

export function logEarlyDataDirMigrationReport(
  report: EarlyDataDirMigrationReport | null,
  logger: DataDirMigrationLogger,
): void {
  if (!report) return;
  if (report.appliedEnvAliases.length > 0) {
    logger.info(`[data-dir] YCODE_* env aliases applied: ${report.appliedEnvAliases.join(",")}`);
  }
  for (const result of report.results) {
    const summary = `[data-dir] ${result.flavor} ${result.legacyPath} -> ${result.nextPath}: ${result.outcome}`;
    const detail = result.detail ? ` (${result.detail})` : "";
    const reason = result.plan.action === "none" ? ` reason=${result.plan.reason}` : "";
    switch (result.outcome) {
      case "migrated":
      case "created":
      case "linked":
        logger.info(`${summary}${detail}`);
        break;
      case "unchanged":
        break;
      case "skipped":
        // 未允许 rename（开发/隔离）是预期行为，不升级为 warn。
        if (result.plan.action === "none" && result.plan.reason === "rename-not-allowed") {
          logger.info(`${summary}${reason}`);
        } else {
          logger.warn(`${summary}${reason}${detail}`);
        }
        break;
      case "rolled-back":
        logger.warn(`${summary}${detail}`);
        break;
      case "failed":
        logger.error(`${summary}${detail}`);
        break;
    }
  }
}
