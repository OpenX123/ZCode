/**
 * github-desktop-update 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const githubDesktopUpdateModule = {
  id: "github-desktop-update",
  requires: ["shared"],
  provides: ["github-desktop-update"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
