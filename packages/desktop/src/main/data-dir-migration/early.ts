/**
 * 必须是 Desktop main index.ts 的第一条 import：只依赖 electron、Node 内置模块与
 * @zcode/shared/ycode-data-root，保证迁移先于 services、logger、setting.json 读取和子进程。
 */
import { app } from "electron";
import type { EarlyDataDirMigrationReport } from "./contract.js";
import { runEarlyDataDirMigration } from "./bootstrap.js";

let earlyReport: EarlyDataDirMigrationReport | null = null;
try {
  earlyReport = runEarlyDataDirMigration({ env: process.env, isPackaged: app.isPackaged });
} catch (error) {
  // 迁移只是体验改进，任何意外都不能阻断启动；旧目录保持可用，解析器按实际存在性选择。
  earlyReport = {
    allowRename: false,
    appliedEnvAliases: [],
    results: [],
  };
  console.warn("[data-dir] early migration crashed", error);
}

export function getEarlyDataDirMigrationReport(): EarlyDataDirMigrationReport | null {
  return earlyReport;
}
