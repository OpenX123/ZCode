// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const subagentDisplayModule = {
  id: "subagent-display",
  owner: "conversation",
  requires: ["ui", "shared"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
