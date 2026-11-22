/**
 * usage-stats-local-protocol 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const usageStatsLocalProtocolModule = {
  id: "usage-stats-local-protocol",
  requires: [],
  provides: ["usage-stats-local-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
