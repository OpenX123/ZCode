import { useWorkbenchTabsStore, initializeWorkbenchTabs } from "@/v4/workbench-tabs/index.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";

export interface WorkbenchSessionTarget extends PaneWorkspaceScope {
  readonly sessionId: string;
}

/** 侧栏只向唯一工作台提交一次打开意图；已有会话由 owner 聚焦原位置。 */
export function selectWorkbenchSession(
  shellBinding: WorkbenchSessionBinding | null,
  target: WorkbenchSessionTarget,
): void {
  const { sessionId, ...workspaceScope } = target;
  initializeWorkbenchTabs(
    shellBinding?.workspaceScope ?? workspaceScope,
    shellBinding?.sessionId ?? null,
  );
  useWorkbenchTabsStore.getState().openSession({ workspaceScope, sessionId });
}
