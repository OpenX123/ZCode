import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkbenchSessionBinding } from "./contract.js";
import { useWorkbenchTabsStore } from "./store.js";

/** 已经由权威 Host 确认的会话统一提交导航；不创建事实或发送 prompt。 */
export function openSessionNavigation(
  binding: WorkbenchSessionBinding,
  openWorkspaceTab: (
    workspacePath: string,
    options?: { workspaceIdentity?: string; remoteSessionId?: string },
  ) => unknown,
  workbenchEnabled = true,
): void {
  if (!binding.sessionId) return;
  const scope = binding.workspaceScope;
  openWorkspaceTab(scope.workspacePath, {
    workspaceIdentity: scope.workspaceIdentity,
    remoteSessionId: scope.remoteSessionId,
  });
  useZCodeSessionStore
    .getState()
    .setActiveTaskId(scope.workspacePath, binding.sessionId, scope.workspaceIdentity);
  if (workbenchEnabled) useWorkbenchTabsStore.getState().openSession(binding);
}
