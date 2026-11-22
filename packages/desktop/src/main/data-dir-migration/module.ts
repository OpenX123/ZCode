/**
 * data-dir-migration 模块清单：Desktop main 启动最早期的 ~/.zcode → ~/.ycode 本机迁移触发点。
 * 迁移执行逻辑在 ycode-data-root（shared），本模块只负责时机、候选目录与报告。
 */
export const desktopDataDirMigrationModule = {
  id: "desktop-data-dir-migration",
  requires: ["ycode-data-root"],
  provides: ["desktop-data-dir-migration"],
  publicEntrypoints: ["index.ts", "contract.ts", "early.ts"],
} as const;
