/**
 * project-sidebar 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const projectSidebarModule = {
  id: "project-sidebar",
  requires: [
    "services",
    "shared",
    "ui",
    "external-engine-ui",
    "conversation-workspace-target",
    "remote-connection-flow",
    "conversation-workbench",
    "side-pane-full-view",
  ],
  provides: ["project-sidebar"],
  publicEntrypoints: [
    "index.tsx",
    "WorkbenchLayoutButton.tsx",
    "WorkbenchPaneHeaders.tsx",
    "contract.ts",
    "remote-project-connection.ts",
    "useSavedWorkflowProjectOptions.ts",
    "RemoteProjectMenu.tsx",
    "WorkspaceDragOverlay.tsx",
    "useRemoteProjectConnectionPresentation.ts",
    "OfflineRemoteProjectRows.tsx",
    "RemoteConversationDisconnected.tsx",
  ],
} as const;
