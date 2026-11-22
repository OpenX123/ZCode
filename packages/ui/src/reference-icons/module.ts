// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const referenceIconsModule = {
  id: "reference-icons",
  owner: "conversation",
  requires: ["shared", "ui", "session-navigation"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
