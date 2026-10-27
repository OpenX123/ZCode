// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchPaneHeaders } from "@/project-sidebar/WorkbenchPaneHeaders.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

const fixture = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  projects: [] as Record<string, unknown>[],
  workspaces: {} as Record<string, { taskMetas: Record<string, unknown> }>,
  resize: null as ResizeObserverCallback | null,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ workspaces: fixture.workspaces }),
}));
vi.mock("@/store/zcodeSessionStoreSelectors.js", () => ({
  getTaskMeta: (workspace: { taskMetas: Record<string, unknown> }, id: string) =>
    workspace.taskMetas[id],
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => ({
    projects: fixture.projects,
    factTree: { tasks: fixture.tasks },
  }),
}));
vi.mock("@/side-pane-full-view/index.js", () => ({
  useConversationPanePresentation: () => ({ presentation: "docked" }),
}));
vi.mock("@/WorkspaceHeaderSections.js", () => ({
  WorkspaceHeaderTitleSection: (props: Record<string, unknown>) =>
    createElement(
      "div",
      {
        "data-session": props.activeTaskId,
        "data-workspace": props.workspaceIdentity || props.workspaceAbsPath,
      },
      props.leadingContent as import("react").ReactNode,
      createElement("h1", {}, props.activeTaskTitle as string),
      createElement("button", { "aria-label": "scoped-menu" }, "⋯"),
    ),
}));
vi.mock("@/project-sidebar/ProjectComposerMenu.js", () => ({
  ProjectComposerMenu: ({ draftTabId }: { draftTabId: string }) =>
    createElement(
      "button",
      { "data-draft-tab": draftTabId, "data-testid": "project-picker" },
      "chat.empty.selectProject",
    ),
}));

beforeEach(() => {
  fixture.tasks = [];
  fixture.projects = [];
  fixture.workspaces = {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        fixture.resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const local = { workspacePath: "/same" };
const remote = {
  workspacePath: "/same",
  workspaceIdentity: "remote:server:host:/same",
  remoteSessionId: "remote-1",
};
const renderHeaders = () => render(createElement(WorkbenchPaneHeaders, { onCreateTask: vi.fn() }));

describe("每栏工作台标题", () => {
  it("相同目录的本地和远端会话按完整身份显示各自项目、标题和菜单 scope", () => {
    const state = useWorkbenchTabsStore.getState();
    state.initialize(local, "same-session");
    state.openSession({ workspaceScope: remote, sessionId: "same-session" }, "right");
    const [left, right] = useWorkbenchTabsStore.getState().groups;
    fixture.tasks = [
      { taskId: "same-session", workspacePath: "/same", projectId: "a", hostId: "local" },
      {
        taskId: "same-session",
        ...remote,
        projectId: "b",
        hostId: "remote:server:host",
      },
    ];
    fixture.projects = [
      { id: "a", hostId: "local", name: "本地项目" },
      { id: "b", hostId: "remote:server:host", name: "远端项目" },
    ];
    fixture.workspaces = {
      "/same": { taskMetas: { "same-session": { title: "左侧会话", provider: "glm" } } },
      [remote.workspaceIdentity]: {
        taskMetas: { "same-session": { title: "右侧会话", provider: "glm" } },
      },
    };
    const view = renderHeaders();
    const leftHeader = view.getByTestId(`workbench-pane-header-${left!.activeTabId}`);
    const rightHeader = view.getByTestId(`workbench-pane-header-${right!.activeTabId}`);
    expect(within(leftHeader).getByText("本地项目")).toBeTruthy();
    expect(within(leftHeader).getByRole("heading").textContent).toBe("左侧会话");
    expect(leftHeader.querySelector("[data-workspace]")?.getAttribute("data-workspace")).toBe(
      "/same",
    );
    expect(within(rightHeader).getByText("远端项目")).toBeTruthy();
    expect(within(rightHeader).getByRole("heading").textContent).toBe("右侧会话");
    expect(rightHeader.querySelector("[data-workspace]")?.getAttribute("data-workspace")).toBe(
      remote.workspaceIdentity,
    );
    expect(view.queryByTestId("project-picker")).toBeNull();
  });

  it("单栏草稿保留新会话标题和定向项目入口，不显示关闭分栏", () => {
    useWorkbenchTabsStore.getState().initialize(local);
    const id = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    const view = renderHeaders();
    expect(view.getByRole("heading").textContent).toBe("workbench.newConversation");
    expect(view.getByTestId("project-picker").getAttribute("data-draft-tab")).toBe(id);
    expect(view.queryByTestId(`workbench-close-pane-${id}`)).toBeNull();
  });

  it("关闭非焦点整栏只提交一次合栏，保留目标当前会话与源栏全部草稿", () => {
    useWorkbenchTabsStore.getState().initialize(local, "target-session");
    const firstDraft = useWorkbenchTabsStore.getState().splitRight(local);
    const secondDraft = useWorkbenchTabsStore.getState().newDraft(local);
    const target = useWorkbenchTabsStore.getState().groups[0]!;
    useWorkbenchTabsStore.getState().activateTab(target.activeTabId);
    const view = renderHeaders();
    const updates: string[] = [];
    const unsubscribe = useWorkbenchTabsStore.subscribe((state) =>
      updates.push(state.focusedGroupId),
    );
    const close = view.getByTestId(`workbench-close-pane-${secondDraft}`);
    fireEvent.pointerDown(close);
    fireEvent.focus(close);
    expect(updates).toEqual([]);
    fireEvent.click(close);
    unsubscribe();
    const state = useWorkbenchTabsStore.getState();
    expect(updates).toEqual([target.id]);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.activeTabId).toBe(target.activeTabId);
    expect(state.groups[0]!.tabIds).toEqual([target.activeTabId, firstDraft, secondDraft]);
    expect(state.tabs[firstDraft]?.draftId).toBe(firstDraft);
    expect(state.tabs[secondDraft]?.draftId).toBe(secondDraft);
    expect(view.queryByRole("button", { name: "workbench.closePane" })).toBeNull();
  });

  it("标题沿用正文比例，窄屏只投影焦点栏并可随焦点切换", () => {
    useWorkbenchTabsStore.getState().initialize(local, "left");
    const right = useWorkbenchTabsStore.getState().splitRight(remote);
    useWorkbenchTabsStore.getState().setRatio(0.4);
    const [leftGroup, rightGroup] = useWorkbenchTabsStore.getState().groups;
    const view = renderHeaders();
    expect(
      view.container.querySelector<HTMLElement>(`[data-workbench-header-group="${leftGroup!.id}"]`)
        ?.style.width,
    ).toBe("40%");
    expect(
      view.container.querySelector<HTMLElement>(`[data-workbench-header-group="${rightGroup!.id}"]`)
        ?.style.width,
    ).toBe("60%");
    act(() =>
      fixture.resize?.(
        [{ contentRect: { width: 600 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(view.queryByTestId(`workbench-pane-header-${leftGroup!.activeTabId}`)).toBeNull();
    expect(view.getByTestId(`workbench-pane-header-${right}`)).toBeTruthy();
    act(() => useWorkbenchTabsStore.getState().activateTab(leftGroup!.activeTabId));
    expect(view.queryByTestId(`workbench-pane-header-${right}`)).toBeNull();
    expect(view.getByTestId(`workbench-pane-header-${leftGroup!.activeTabId}`)).toBeTruthy();
  });
});
