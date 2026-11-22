/**
 * skills-hub-ui 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const skillsHubUiModule = {
  id: "skills-hub-ui",
  requires: ["ui", "shared", "skills-hub-contract"],
  provides: ["skills-hub-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "i18n.ts"],
} as const;
