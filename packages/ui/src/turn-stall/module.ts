// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const turnStallModule = {
  id: "turn-stall",
  owner: "conversation",
  requires: ["shared", "ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
