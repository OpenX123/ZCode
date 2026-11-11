/**
 * mobile-remote-settings 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const mobileRemoteSettingsModule = {
  id: "mobile-remote-settings",
  requires: ["mobile-remote-link", "ui"],
  provides: ["mobile-remote-settings"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
