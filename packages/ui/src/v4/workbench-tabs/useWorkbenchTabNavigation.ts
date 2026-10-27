import { useEffect, useLayoutEffect, useRef } from "react";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  getFocusedWorkbenchTab,
  workbenchWorkspaceKey,
  type WorkbenchSessionBinding,
  type WorkbenchWorkspaceScope,
} from "./contract.js";
import { useWorkbenchTabsStore } from "./store.js";

/** 旧布局只消费一次；之后 shell 是焦点投影，不再作为第二个布局 owner。 */
export function initializeWorkbenchTabs(
  scope: WorkbenchWorkspaceScope,
  sessionId: string | null,
): void {
  const store = useWorkbenchTabsStore.getState();
  if (store.groups.length) return;
  const legacyGroups = useWorkbenchGroupStore.getState();
  const legacyPanes = usePaneLayoutStore.getState();
  const bindings: WorkbenchSessionBinding[] = [];
  const groups = Object.values(legacyGroups.groups);
  groups.sort(
    (a, b) =>
      Number(b.id === legacyGroups.activeGroupId) - Number(a.id === legacyGroups.activeGroupId),
  );
  for (const group of groups) bindings.push(group.primaryBinding, ...Object.values(group.panes));
  if (!bindings.length && Object.keys(legacyPanes.panes).length) {
    const shellIsSecondary =
      sessionId &&
      Object.values(legacyPanes.panes).some(
        (binding) =>
          binding.sessionId === sessionId &&
          workbenchWorkspaceKey(binding.workspaceScope) === workbenchWorkspaceKey(scope),
      );
    bindings.push(
      { workspaceScope: scope, sessionId: shellIsSecondary ? null : sessionId },
      ...Object.values(legacyPanes.panes),
    );
  }
  const ownedBindings = bindings.map((binding) => {
    if (binding.sessionId !== null) return binding;
    const workspace = useZCodeSessionStore
      .getState()
      .getWorkspaceState(
        binding.workspaceScope.workspacePath,
        binding.workspaceScope.workspaceIdentity,
      );
    return {
      ...binding,
      projectId: workspace.draftProjectId,
      taskGroupId: workspace.draftTaskGroupId,
      inheritRootDraft: true,
    };
  });
  const workspace = useZCodeSessionStore
    .getState()
    .getWorkspaceState(scope.workspacePath, scope.workspaceIdentity);
  const legacyRoot = groups[0]?.root ?? legacyPanes.root;
  if (ownedBindings.length)
    store.migrateLegacy(ownedBindings, legacyRoot.type === "split" ? legacyRoot.ratio : undefined);
  else
    store.initialize(scope, sessionId, {
      projectId: workspace.draftProjectId,
      taskGroupId: workspace.draftTaskGroupId,
      inheritRootDraft: true,
    });
  // 迁移是所有权转移，消费旧 owner 可防后续关闭或恢复时旧布局复活。
  legacyGroups.resetWorkbenchGroups();
  legacyPanes.resetToPrimaryPane();
}

export function useWorkbenchTabNavigation({
  scope,
  sessionId,
  enabled,
  onActiveChange,
}: {
  scope: WorkbenchWorkspaceScope;
  sessionId: string | null;
  enabled: boolean;
  onActiveChange?: (scope: WorkbenchWorkspaceScope, sessionId: string | null) => void;
}) {
  const focusedTab = useWorkbenchTabsStore(getFocusedWorkbenchTab);
  const scopeKey = workbenchWorkspaceKey(scope);
  const observedShell = useRef(false);
  useLayoutEffect(() => {
    if (!enabled) return;
    const initialNavigation = !observedShell.current;
    observedShell.current = true;
    initializeWorkbenchTabs(scope, sessionId);
    useWorkbenchTabsStore.getState().refreshWorkspaceScope(scope);
    const current = useWorkbenchTabsStore.getState();
    const focused = getFocusedWorkbenchTab(current);
    if (
      !initialNavigation &&
      sessionId &&
      (focused?.sessionId !== sessionId ||
        !focused ||
        workbenchWorkspaceKey(focused.workspaceScope) !== scopeKey)
    ) {
      current.openSession({ workspaceScope: scope, sessionId });
    }
    // 只消费外部导航坐标变化；工作台自身 focus 不允许被仍未更新的 shell 覆盖。
  }, [enabled, scopeKey, scope.remoteSessionId, sessionId]);
  useEffect(() => {
    if (!enabled || !focusedTab || focusedTab.readOnly) return;
    const latest = getFocusedWorkbenchTab(useWorkbenchTabsStore.getState());
    if (latest?.id !== focusedTab.id || latest.sessionId !== focusedTab.sessionId) return;
    if (
      scopeKey === workbenchWorkspaceKey(focusedTab.workspaceScope) &&
      sessionId === focusedTab.sessionId
    )
      return;
    onActiveChange?.(focusedTab.workspaceScope, focusedTab.sessionId);
  }, [enabled, focusedTab, onActiveChange, scopeKey, sessionId]);
  return focusedTab;
}
