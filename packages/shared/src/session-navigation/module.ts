/**
 * session-navigation 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sessionNavigationModule = {
  id: "session-navigation",
  requires: [],
  provides: ["session-navigation"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
