/**
 * skills-hub-sync 模块清单（architecture-governance managed 模块）。
 * 层：adapters（文件系统链接与清单写入）。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const skillsHubSyncModule = {
  id: "skills-hub-sync",
  requires: ["services", "shared", "rpc", "skills-hub-contract"],
  provides: ["skills-hub-sync"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
