// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const errorExplanationsModule = {
  id: "error-explanations",
  owner: "conversation",
  requires: [],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
