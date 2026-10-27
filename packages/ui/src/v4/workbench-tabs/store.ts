import { create } from "zustand";
import { createUuid } from "@zcode/shared";
import {
  type WorkbenchDraftOptions,
  type WorkbenchSessionBinding,
  type WorkbenchStorage,
  type WorkbenchTab,
  type WorkbenchTabGroup,
  type WorkbenchTabsState,
  type WorkbenchWorkspaceScope,
} from "./contract.js";
import {
  clampWorkbenchRatio,
  defaultWorkbenchStorage,
  readWorkbenchTabs,
  persistWorkbenchTabs,
} from "./persistence.js";

export { WORKBENCH_TABS_STORAGE_KEY } from "./persistence.js";

function sameWorkspace(a: WorkbenchWorkspaceScope, b: WorkbenchWorkspaceScope): boolean {
  const aIdentity = a.workspaceIdentity?.trim();
  const bIdentity = b.workspaceIdentity?.trim();
  // 远端身份不能回落目录匹配，否则同路径的另一 Source 会被重连结果覆盖。
  return aIdentity || bIdentity
    ? Boolean(aIdentity && bIdentity && aIdentity === bIdentity)
    : a.workspacePath === b.workspacePath;
}

function sameSession(a: WorkbenchSessionBinding, b: WorkbenchSessionBinding): boolean {
  return (
    a.sessionId !== null &&
    a.sessionId === b.sessionId &&
    sameWorkspace(a.workspaceScope, b.workspaceScope)
  );
}

function removeTabFromGroups(
  groups: readonly WorkbenchTabGroup[],
  tabId: string,
): WorkbenchTabGroup[] {
  return groups.flatMap((group) => {
    if (!group.tabIds.includes(tabId)) return [group];
    const index = group.tabIds.indexOf(tabId);
    const tabIds = group.tabIds.filter((id) => id !== tabId);
    return tabIds.length
      ? [
          {
            ...group,
            tabIds,
            activeTabId:
              group.activeTabId === tabId
                ? tabIds[Math.min(index, tabIds.length - 1)]!
                : group.activeTabId,
          },
        ]
      : [];
  });
}

export function createWorkbenchTabsStore(
  options: {
    storage?: WorkbenchStorage | null;
    createId?: () => string;
  } = {},
) {
  const storage = options.storage === undefined ? defaultWorkbenchStorage() : options.storage;
  const createId = options.createId ?? createUuid;
  const makeTab = (
    binding: WorkbenchSessionBinding,
    draftOptions: WorkbenchDraftOptions = {},
  ): WorkbenchTab => {
    const id = createId();
    return {
      ...binding,
      id,
      ...(binding.sessionId === null ? { draftId: id } : {}),
      ...(draftOptions.projectId !== undefined ? { projectId: draftOptions.projectId } : {}),
      ...(draftOptions.taskGroupId !== undefined ? { taskGroupId: draftOptions.taskGroupId } : {}),
      ...(draftOptions.inheritRootDraft ? { inheritRootDraft: true } : {}),
    };
  };
  const store = create<WorkbenchTabsState>((set, get) => {
    const append = (tab: WorkbenchTab, groupId?: string): string => {
      const current = get();
      const targetId = groupId ?? current.focusedGroupId;
      const group = current.groups.find((item) => item.id === targetId) ?? current.groups[0];
      const nextGroup = group
        ? { ...group, tabIds: [...group.tabIds, tab.id], activeTabId: tab.id }
        : { id: createId(), tabIds: [tab.id], activeTabId: tab.id };
      set({
        tabs: { ...current.tabs, [tab.id]: tab },
        groups: group
          ? current.groups.map((item) => (item.id === group.id ? nextGroup : item))
          : [nextGroup],
        focusedGroupId: nextGroup.id,
      });
      return tab.id;
    };
    return {
      ...readWorkbenchTabs(storage),
      initialize(scope, sessionId = null, draftOptions) {
        if (get().groups.length) return;
        append(makeTab({ workspaceScope: scope, sessionId }, draftOptions));
      },
      openSession(binding, side) {
        get().refreshWorkspaceScope(binding.workspaceScope);
        const current = get();
        const existing = Object.values(current.tabs).find((tab) => sameSession(tab, binding));
        if (side) {
          const target = current.groups[side === "right" ? 1 : 0];
          if (target) {
            if (existing) {
              get().moveTab(existing.id, target.id, target.tabIds.length);
              return existing.id;
            }
            return append(makeTab(binding), target.id);
          }
          if (side === "right") {
            const tab = existing ?? makeTab(binding);
            const left = current.groups[0];
            const remaining = left?.tabIds.filter((id) => id !== tab.id) ?? [];
            // 唯一会话移往新右栏时保留独立草稿，一次提交避免中间焦点触发错误订阅。
            const draft = remaining.length
              ? null
              : makeTab(
                  { workspaceScope: tab.workspaceScope, sessionId: null },
                  { projectId: existing?.projectId, taskGroupId: existing?.taskGroupId },
                );
            const leftTabIds = draft ? [draft.id] : remaining;
            const right = { id: createId(), tabIds: [tab.id], activeTabId: tab.id };
            set({
              tabs: { ...current.tabs, ...(draft ? { [draft.id]: draft } : {}), [tab.id]: tab },
              groups: [
                {
                  id: left?.id ?? createId(),
                  tabIds: leftTabIds,
                  activeTabId:
                    left && left.activeTabId !== tab.id ? left.activeTabId : leftTabIds[0]!,
                },
                right,
              ],
              focusedGroupId: right.id,
            });
            return tab.id;
          }
        }
        if (existing) {
          get().activateTab(existing.id);
          return existing.id;
        }
        return append(makeTab(binding));
      },
      newDraft(scope, draftOptions = {}) {
        const replaceId = draftOptions.replaceDraftTabId;
        if (replaceId !== undefined) {
          const current = get();
          const tab = current.tabs[replaceId];
          // 项目菜单打开后首发可能已被接纳，不能改写已发送会话或补建另一份草稿。
          if (!tab || tab.sessionId !== null) return replaceId;
          const replacement = {
            ...tab,
            workspaceScope: scope,
            ...(draftOptions.projectId !== undefined ? { projectId: draftOptions.projectId } : {}),
            ...(draftOptions.taskGroupId !== undefined
              ? { taskGroupId: draftOptions.taskGroupId }
              : {}),
          };
          if (
            tab.workspaceScope.workspacePath !== scope.workspacePath ||
            tab.workspaceScope.workspaceIdentity !== scope.workspaceIdentity ||
            tab.workspaceScope.remoteSessionId !== scope.remoteSessionId ||
            tab.projectId !== replacement.projectId ||
            tab.taskGroupId !== replacement.taskGroupId
          )
            set({ tabs: { ...current.tabs, [replaceId]: replacement } });
          return replaceId;
        }
        return append(
          makeTab({ workspaceScope: scope, sessionId: null }, draftOptions),
          draftOptions.groupId,
        );
      },
      splitRight(scope, draftOptions = {}) {
        if (!get().groups.length) get().initialize(scope, null, draftOptions);
        const right = get().groups[1];
        if (right) return get().newDraft(scope, { ...draftOptions, groupId: right.id });
        const tab = makeTab({ workspaceScope: scope, sessionId: null }, draftOptions);
        const group = { id: createId(), tabIds: [tab.id], activeTabId: tab.id };
        set((state) => ({
          tabs: { ...state.tabs, [tab.id]: tab },
          groups: [...state.groups, group],
          focusedGroupId: group.id,
        }));
        return tab.id;
      },
      activateTab(tabId) {
        const group = get().groups.find((item) => item.tabIds.includes(tabId));
        if (!group || (group.activeTabId === tabId && get().focusedGroupId === group.id)) return;
        set((state) => ({
          groups: state.groups.map((item) =>
            item.id === group.id && item.activeTabId !== tabId
              ? { ...item, activeTabId: tabId }
              : item,
          ),
          focusedGroupId: group.id,
        }));
      },
      moveTab(tabId, targetGroupId, targetIndex, options) {
        const current = get();
        const movingIds = typeof tabId === "string" ? [tabId] : tabId;
        const moving = new Set(movingIds);
        if (
          !movingIds.length ||
          moving.size !== movingIds.length ||
          !current.groups.some((group) => group.id === targetGroupId) ||
          movingIds.some(
            (id) => !current.tabs[id] || !current.groups.some((group) => group.tabIds.includes(id)),
          )
        )
          return;
        // 整栏关闭必须一次合入全部视图，避免逐页移动触发中间焦点和草稿订阅。
        const groups = current.groups
          .map((group) => {
            const tabIds = group.tabIds.filter((id) => !moving.has(id));
            if (group.id === targetGroupId) {
              tabIds.splice(Math.max(0, Math.min(tabIds.length, targetIndex)), 0, ...movingIds);
              return {
                ...group,
                tabIds,
                activeTabId: options?.preserveTargetActive ? group.activeTabId : movingIds[0]!,
              };
            }
            return {
              ...group,
              tabIds,
              activeTabId: moving.has(group.activeTabId) ? (tabIds[0] ?? "") : group.activeTabId,
            };
          })
          .filter((group) => group.tabIds.length);
        set({ groups, focusedGroupId: targetGroupId });
      },
      closeTab(tabId) {
        const current = get();
        const tab = current.tabs[tabId];
        if (!tab) return;
        const tabs = { ...current.tabs };
        delete tabs[tabId];
        const groups = removeTabFromGroups(current.groups, tabId);
        if (!groups.length) {
          const replacement = makeTab(
            { workspaceScope: tab.workspaceScope, sessionId: null },
            { projectId: tab.projectId, taskGroupId: tab.taskGroupId },
          );
          const group = { id: createId(), tabIds: [replacement.id], activeTabId: replacement.id };
          set({
            tabs: { [replacement.id]: replacement },
            groups: [group],
            focusedGroupId: group.id,
          });
          return;
        }
        set({
          tabs,
          groups,
          focusedGroupId: groups.some((group) => group.id === current.focusedGroupId)
            ? current.focusedGroupId
            : groups[0]!.id,
        });
      },
      swapGroups() {
        if (get().groups.length === 2)
          set((state) => ({
            groups: [state.groups[1]!, state.groups[0]!],
            ratio: 1 - state.ratio,
          }));
      },
      setRatio(ratio) {
        const next = clampWorkbenchRatio(ratio);
        if (get().ratio !== next) set({ ratio: next });
      },
      bindSession(tabId, sessionId) {
        const current = get();
        const tab = current.tabs[tabId];
        if (!tab || !sessionId || (tab.sessionId === sessionId && !tab.restoredUnvalidated)) return;
        const binding = { ...tab, sessionId, restoredUnvalidated: false };
        const duplicate = Object.values(current.tabs).find(
          (item) => item.id !== tabId && sameSession(item, binding),
        );
        const tabs = { ...current.tabs, [tabId]: binding };
        if (duplicate) delete tabs[duplicate.id];
        const groups = duplicate
          ? removeTabFromGroups(current.groups, duplicate.id)
          : current.groups;
        set({
          tabs,
          groups,
          focusedGroupId: groups.some((group) => group.id === current.focusedGroupId)
            ? current.focusedGroupId
            : (groups[0]?.id ?? ""),
        });
      },
      refreshWorkspaceScope(scope) {
        const current = get();
        let changed = false;
        const tabs = { ...current.tabs };
        for (const tab of Object.values(current.tabs)) {
          if (!sameWorkspace(tab.workspaceScope, scope)) continue;
          // 断连期的壳层投影可能没有 endpoint，只有明确的新连接可替换已有路由。
          const remoteSessionId =
            scope.remoteSessionId?.trim() || tab.workspaceScope.remoteSessionId;
          if (
            tab.workspaceScope.workspacePath === scope.workspacePath &&
            tab.workspaceScope.remoteSessionId === remoteSessionId
          )
            continue;
          tabs[tab.id] = {
            ...tab,
            workspaceScope: {
              ...tab.workspaceScope,
              workspacePath: scope.workspacePath,
              ...(remoteSessionId ? { remoteSessionId } : {}),
            },
          };
          changed = true;
        }
        if (changed) set({ tabs });
      },
      migrateLegacy(bindings, ratio = 0.5) {
        if (get().groups.length || !bindings.length) return;
        const tabs: Record<string, WorkbenchTab> = {};
        const groups: WorkbenchTabGroup[] = [];
        for (const binding of bindings) {
          if (binding.sessionId && Object.values(tabs).some((tab) => sameSession(tab, binding)))
            continue;
          const tab = makeTab(binding);
          tabs[tab.id] = tab;
          const groupIndex = Object.keys(tabs).length === 1 ? 0 : 1;
          const group = groups[groupIndex];
          if (group) groups[groupIndex] = { ...group, tabIds: [...group.tabIds, tab.id] };
          else groups.push({ id: createId(), tabIds: [tab.id], activeTabId: tab.id });
        }
        if (groups.length)
          set({ tabs, groups, focusedGroupId: groups[0]!.id, ratio: clampWorkbenchRatio(ratio) });
      },
    };
  });
  store.subscribe((state) => persistWorkbenchTabs(storage, state));
  return store;
}

export const useWorkbenchTabsStore = createWorkbenchTabsStore();
