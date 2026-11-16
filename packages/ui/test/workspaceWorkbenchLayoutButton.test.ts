// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorkbenchLayoutButton } from "@/project-sidebar/WorkbenchLayoutButton.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

const fixture = vi.hoisted(() => ({ tasks: [] as Record<string, unknown>[] }));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () =>
    fixture.tasks.length ? { factTree: { tasks: fixture.tasks } } : null,
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: import("react").ReactNode }) => children,
}));

const scope = { workspacePath: "/project" };
beforeEach(() => {
  fixture.tasks = [];
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
  useWorkbenchTabsStore.getState().initialize(scope, "session-a");
});
afterEach(cleanup);
function setup() {
  const view = render(createElement(WorkspaceWorkbenchLayoutButton));
  const menu = () =>
    fireEvent.pointerDown(view.getByTestId("workbench-layout-menu"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
  return { ...view, menu };
}

describe("右上工作台布局入口", () => {
  it("真实会话由菜单原子右移且全局单份，左侧保留同归属独立草稿", () => {
    const current = useWorkbenchTabsStore.getState();
    const original = Object.values(current.tabs)[0]!;
    useWorkbenchTabsStore.setState({
      tabs: { [original.id]: { ...original, projectId: "project-a", taskGroupId: "group-a" } },
    });
    const binding = useWorkbenchTabsStore.getState().tabs[original.id]!;
    const view = setup();
    const updates: unknown[] = [];
    const unsubscribe = useWorkbenchTabsStore.subscribe((state) => updates.push(state));
    view.menu();
    fireEvent.click(view.getByTestId(`workbench-activate-tab-${original.id}`));
    unsubscribe();
    const state = useWorkbenchTabsStore.getState();
    expect(updates).toHaveLength(1);
    expect(state.groups).toHaveLength(2);
    expect(state.groups[1]!.tabIds).toEqual([original.id]);
    expect(state.focusedGroupId).toBe(state.groups[1]!.id);
    expect(state.tabs[original.id]).toBe(binding);
    expect(Object.values(state.tabs).filter((tab) => tab.sessionId === "session-a")).toHaveLength(
      1,
    );
    const draft = state.tabs[state.groups[0]!.activeTabId]!;
    expect(draft).toMatchObject({
      sessionId: null,
      draftId: draft.id,
      workspaceScope: scope,
      projectId: "project-a",
      taskGroupId: "group-a",
    });
    expect(draft.id).not.toBe(original.id);
    view.menu();
    fireEvent.click(view.getByTestId(`workbench-activate-tab-${draft.id}`));
    expect(useWorkbenchTabsStore.getState().groups).toEqual(state.groups);
    expect(useWorkbenchTabsStore.getState().focusedGroupId).toBe(state.groups[0]!.id);
  });

  it("已在右栏的真实会话只聚焦，不重排右栏已有草稿", () => {
    const store = useWorkbenchTabsStore.getState();
    const id = Object.keys(store.tabs)[0]!;
    store.openSession(store.tabs[id]!, "right");
    const draftId = useWorkbenchTabsStore.getState().newDraft(scope);
    const before = useWorkbenchTabsStore.getState();
    const view = setup();
    view.menu();
    fireEvent.click(view.getByTestId(`workbench-activate-tab-${id}`));
    const state = useWorkbenchTabsStore.getState();
    expect(state.groups[1]!.tabIds).toEqual([id, draftId]);
    expect(state.groups[1]!.activeTabId).toBe(id);
    expect(state.tabs).toBe(before.tabs);
  });

  it("菜单打开后的 endpoint 换代以点击时完整绑定右移，同路径本地会话保持独立", () => {
    const remote = { ...scope, workspaceIdentity: "ssh://remote/project", remoteSessionId: "old" };
    const remoteId = useWorkbenchTabsStore
      .getState()
      .openSession({ workspaceScope: remote, sessionId: "session-a" });
    const view = setup();
    view.menu();
    const item = view.getByTestId(`workbench-activate-tab-${remoteId}`);
    act(() => {
      useWorkbenchTabsStore.getState().refreshWorkspaceScope({ ...remote, remoteSessionId: "new" });
      fireEvent.click(item);
    });
    const state = useWorkbenchTabsStore.getState();
    expect(state.groups[1]?.activeTabId).toBe(remoteId);
    expect(state.tabs[remoteId]!.workspaceScope.remoteSessionId).toBe("new");
    expect(Object.values(state.tabs).filter((tab) => tab.sessionId === "session-a")).toHaveLength(
      2,
    );
    expect(
      Object.values(state.tabs).find((tab) => !tab.workspaceScope.workspaceIdentity)
        ?.workspaceScope,
    ).toEqual(scope);
  });

  it("菜单目标已经关闭或失去栏位时不复活会话", () => {
    const view = setup();
    const id = Object.keys(useWorkbenchTabsStore.getState().tabs)[0]!;
    view.menu();
    const item = view.getByTestId(`workbench-activate-tab-${id}`);
    let afterClose: ReturnType<typeof useWorkbenchTabsStore.getState>;
    act(() => {
      useWorkbenchTabsStore.getState().closeTab(id);
      afterClose = useWorkbenchTabsStore.getState();
      fireEvent.click(item);
    });
    expect(useWorkbenchTabsStore.getState()).toBe(afterClose!);
  });

  it("菜单旧条目失去 group 归属后不创建右栏", () => {
    const view = setup();
    const id = Object.keys(useWorkbenchTabsStore.getState().tabs)[0]!;
    view.menu();
    const item = view.getByTestId(`workbench-activate-tab-${id}`);
    let invalidated: ReturnType<typeof useWorkbenchTabsStore.getState>;
    act(() => {
      useWorkbenchTabsStore.setState({ groups: [], focusedGroupId: "" });
      invalidated = useWorkbenchTabsStore.getState();
      fireEvent.click(item);
    });
    expect(useWorkbenchTabsStore.getState()).toBe(invalidated!);
  });

  it("远端离线菜单保留原 identity、endpoint 与只读资格，不借用同路径本地绑定", () => {
    const remote = {
      ...scope,
      workspaceIdentity: "ssh://offline/project",
      remoteSessionId: "offline-endpoint",
    };
    const id = useWorkbenchTabsStore.getState().openSession({
      workspaceScope: remote,
      sessionId: "session-a",
      readOnly: true,
      restoredUnvalidated: true,
    });
    const original = useWorkbenchTabsStore.getState().tabs[id];
    const view = setup();
    view.menu();
    fireEvent.click(view.getByTestId(`workbench-activate-tab-${id}`));
    expect(useWorkbenchTabsStore.getState().tabs[id]).toBe(original);
    expect(useWorkbenchTabsStore.getState().groups[1]?.activeTabId).toBe(id);
  });

  it("菜单缺缓存时显示完整事实标题，不显示截短会话 ID", () => {
    const title = "UX09 一个完整的目录事实标题";
    fixture.tasks = [{ taskId: "session-a", workspacePath: "/project", title, updatedAt: 2 }];
    const view = setup();
    view.menu();
    const tab = Object.values(useWorkbenchTabsStore.getState().tabs)[0]!;
    const item = view.getByTestId(`workbench-activate-tab-${tab.id}`);
    expect(item.textContent).toContain(title);
    expect(item.getAttribute("title")).toBe(title);
  });

  it("单一图标菜单分栏创建独立草稿，交换不改变视图身份", () => {
    const view = setup();
    const leftId = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    view.menu();
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const rightId = useWorkbenchTabsStore.getState().groups[1]!.activeTabId;
    expect(useWorkbenchTabsStore.getState().tabs[rightId]?.draftId).toBe(rightId);
    view.menu();
    fireEvent.click(view.getByTestId("workbench-swap-groups"));
    expect(useWorkbenchTabsStore.getState().groups.map((group) => group.activeTabId)).toEqual([
      rightId,
      leftId,
    ]);
  });

  it("合栏保留全部草稿，隐藏草稿可通过布局菜单重新激活", () => {
    const view = setup();
    view.menu();
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const original = useWorkbenchTabsStore.getState();
    const leftActive = original.groups[0]!.activeTabId;
    const firstDraft = original.groups[1]!.activeTabId;
    let secondDraft = "";
    act(() => {
      secondDraft = useWorkbenchTabsStore.getState().newDraft(scope);
    });
    view.menu();
    fireEvent.click(view.getByTestId("workbench-merge-groups"));
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(1);
    expect(Object.keys(useWorkbenchTabsStore.getState().tabs)).toHaveLength(3);
    expect(useWorkbenchTabsStore.getState().groups[0]!.activeTabId).toBe(leftActive);
    expect(useWorkbenchTabsStore.getState().focusedGroupId).toBe(original.groups[0]!.id);
    view.menu();
    fireEvent.click(view.getByTestId(`workbench-activate-tab-${firstDraft}`));
    expect(useWorkbenchTabsStore.getState().groups[0]!.activeTabId).toBe(firstDraft);
    view.menu();
    fireEvent.click(view.getByTestId("workbench-close-view"));
    expect(useWorkbenchTabsStore.getState().tabs[firstDraft]).toBeUndefined();
    expect(useWorkbenchTabsStore.getState().tabs[secondDraft]).toBeTruthy();
  });

  it("草稿移动到另一栏后自动合栏，保留原来的会话绑定", () => {
    const view = setup();
    view.menu();
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const state = useWorkbenchTabsStore.getState();
    const leftId = state.groups[0]!.activeTabId;
    const rightId = state.groups[1]!.activeTabId;
    view.menu();
    fireEvent.click(view.getByTestId("workbench-move-to-other-group"));
    expect(useWorkbenchTabsStore.getState().groups[0]!.tabIds).toEqual([leftId, rightId]);
    expect(useWorkbenchTabsStore.getState().tabs[leftId]?.sessionId).toBe("session-a");
    expect(useWorkbenchTabsStore.getState().tabs[rightId]?.sessionId).toBeNull();
  });
});
