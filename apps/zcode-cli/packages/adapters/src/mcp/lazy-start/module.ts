/**
 * cli-mcp-lazy-start 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliMcpLazyStartModule = {
  id: "cli-mcp-lazy-start",
  requires: ["zcode-cli"],
  provides: ["cli-mcp-lazy-start"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
