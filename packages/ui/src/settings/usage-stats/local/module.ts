/**
 * usage-stats-local-ui 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const usageStatsLocalUiModule = {
  id: "usage-stats-local-ui",
  requires: ["shared", "ui"],
  provides: ["usage-stats-local-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "i18n.ts"],
} as const;
