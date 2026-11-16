/** 只登记 Host 既有日志 owner；保留原类路径与 manager 调用链。 */
export const sourceServerOperationLogsModule = {
  id: "source-server-operation-logs",
  requires: ["desktop", "rpc", "server", "shared"],
  provides: ["source-server-operation-logs"],
  publicEntrypoints: [
    "packages/desktop/src/host/sourceServerOperationLogs.ts",
    "packages/desktop/src/host/source-server-operation-logs-contract/contract.ts",
  ],
} as const;
