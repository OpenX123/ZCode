import {
  workbenchWorkspaceKey,
  type WorkbenchStorage,
  type WorkbenchTab,
  type WorkbenchTabGroup,
  type WorkbenchTabsSnapshot,
} from "./contract.js";

export const WORKBENCH_TABS_STORAGE_KEY = "zcode-conversation-workbench:v1";
export const EMPTY_WORKBENCH: WorkbenchTabsSnapshot = {
  groups: [],
  tabs: {},
  focusedGroupId: "",
  ratio: 0.5,
};

export function clampWorkbenchRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0.25, Math.min(0.75, ratio)) : 0.5;
}

export function defaultWorkbenchStorage(): WorkbenchStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 恢复只读取布局，缺席的远端连接留给会话自身处理，不能推断成删除。 */
export function readWorkbenchTabs(storage: WorkbenchStorage | null): WorkbenchTabsSnapshot {
  try {
    const raw = JSON.parse(storage?.getItem(WORKBENCH_TABS_STORAGE_KEY) ?? "null");
    if (!raw || !Array.isArray(raw.groups) || !raw.tabs || typeof raw.tabs !== "object")
      return EMPTY_WORKBENCH;
    const tabs: Record<string, WorkbenchTab> = {};
    const groups: WorkbenchTabGroup[] = [];
    const seenSessions = new Set<string>();
    for (const group of raw.groups.slice(0, 2)) {
      if (
        !group ||
        typeof group.id !== "string" ||
        !Array.isArray(group.tabIds) ||
        groups.some((item) => item.id === group.id)
      )
        continue;
      const tabIds: string[] = [];
      for (const tabId of group.tabIds) {
        const tab = typeof tabId === "string" ? raw.tabs[tabId] : null;
        const scope = tab?.workspaceScope;
        if (
          !tab ||
          tab.id !== tabId ||
          tabs[tabId] ||
          typeof scope?.workspacePath !== "string" ||
          !scope.workspacePath.trim()
        )
          continue;
        if (tab.sessionId !== null && (typeof tab.sessionId !== "string" || !tab.sessionId))
          continue;
        if (tab.sessionId === null && (typeof tab.draftId !== "string" || !tab.draftId)) continue;
        const workspaceScope = {
          workspacePath: scope.workspacePath,
          ...(typeof scope.workspaceIdentity === "string" && scope.workspaceIdentity.trim()
            ? { workspaceIdentity: scope.workspaceIdentity.trim() }
            : {}),
          ...(typeof scope.remoteSessionId === "string"
            ? { remoteSessionId: scope.remoteSessionId }
            : {}),
        };
        const sessionKey = JSON.stringify([workbenchWorkspaceKey(workspaceScope), tab.sessionId]);
        if (tab.sessionId && seenSessions.has(sessionKey)) continue;
        if (tab.sessionId) seenSessions.add(sessionKey);
        tabs[tabId] = {
          id: tabId,
          workspaceScope,
          sessionId: tab.sessionId,
          ...(typeof tab.draftId === "string" ? { draftId: tab.draftId } : {}),
          ...(tab.projectId === null || typeof tab.projectId === "string"
            ? { projectId: tab.projectId }
            : {}),
          ...(tab.taskGroupId === null || typeof tab.taskGroupId === "string"
            ? { taskGroupId: tab.taskGroupId }
            : {}),
          ...(tab.readOnly === true ? { readOnly: true } : {}),
          ...(tab.inheritRootDraft === true ? { inheritRootDraft: true } : {}),
          ...(tab.sessionId ? { restoredUnvalidated: true } : {}),
        };
        tabIds.push(tabId);
      }
      if (tabIds.length)
        groups.push({
          id: group.id,
          tabIds,
          activeTabId: tabIds.includes(group.activeTabId) ? group.activeTabId : tabIds[0]!,
        });
    }
    if (!groups.length) return EMPTY_WORKBENCH;
    return {
      groups,
      tabs,
      focusedGroupId: groups.some((group) => group.id === raw.focusedGroupId)
        ? raw.focusedGroupId
        : groups[0]!.id,
      ratio: clampWorkbenchRatio(raw.ratio),
    };
  } catch {
    return EMPTY_WORKBENCH;
  }
}

export function persistWorkbenchTabs(
  storage: WorkbenchStorage | null,
  state: WorkbenchTabsSnapshot,
): void {
  try {
    storage?.setItem(
      WORKBENCH_TABS_STORAGE_KEY,
      JSON.stringify({
        groups: state.groups,
        tabs: state.tabs,
        focusedGroupId: state.focusedGroupId,
        ratio: state.ratio,
      }),
    );
  } catch {
    /* 存储不可用时仍保留当前窗口的可操作状态。 */
  }
}
