// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorkbenchLayoutButton } from "@/project-sidebar/WorkbenchLayoutButton.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";
import {
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

const captured = vi.hoisted(() => ({
  panes: new Map<string, Record<string, unknown>>(),
  mounts: new Map<string, number>(),
  directory: null as {
    factTree: {
      tasks: Array<{
        taskId: string;
        workspacePath: string;
        workspaceIdentity?: string;
        projectId: string;
      }>;
    };
    groups: { parents: Map<string, string> };
  } | null,
  toast: vi.fn(),
}));
vi.mock("@/v4/WorkbenchPane.js", async () => {
  const React = await import("react");
  return {
    WorkbenchLeafPane: (props: Record<string, unknown>) => {
      const id = props.paneId as string;
      captured.panes.set(id, props);
      React.useEffect(() => {
        captured.mounts.set(id, (captured.mounts.get(id) ?? 0) + 1);
      }, [id]);
      const [value, setValue] = React.useState("");
      return React.createElement(
        "div",
        { hidden: props.hidden },
        React.createElement("input", {
          "aria-label": `draft-${id}`,
          value,
          onChange: (event: { target: { value: string } }) => setValue(event.target.value),
        }),
      );
    },
  };
});
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/external-engine/index.js", () => ({ TaskClientLogo: () => null }));
vi.mock("@/v4/WorkbenchSplitDivider.js", () => ({
  WorkbenchSplitDivider: () => null,
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => captured.directory,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: captured.toast }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: import("react").ReactNode }) => children,
}));

function reset() {
  cleanup();
  useWorkbenchTabsStore.setState({
    groups: [],
    tabs: {},
    focusedGroupId: "",
    ratio: 0.5,
  });
  usePaneLayoutStore.setState(INITIAL_PANE_LAYOUT);
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  captured.panes.clear();
  captured.mounts.clear();
  captured.directory = null;
  captured.toast.mockClear();
  window.PointerEvent = MouseEvent as typeof PointerEvent;
}
beforeEach(reset);
afterEach(reset);
const scope = { workspacePath: "/workspace" };
const renderWorkbench = (
  options: { compactForRemoteControl?: boolean; [key: string]: unknown } = {},
) =>
  render(
    createElement(
      Fragment,
      {},
      createElement(V4WorkspaceChatArea, { ...scope, sessionId: "main-session", ...options }),
      options.compactForRemoteControl ? null : createElement(WorkspaceWorkbenchLayoutButton),
    ),
  );
const openLayoutMenu = (view: ReturnType<typeof render>) => {
  fireEvent.pointerDown(view.getByTestId("workbench-layout-menu"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
};

describe("双栏工作台会话与草稿生命周期", () => {
  it("右上分栏从会话身份继承项目和分组，不按相同 cwd 猜项目", () => {
    captured.directory = {
      factTree: {
        tasks: [
          {
            taskId: "other-session",
            workspacePath: "/workspace",
            projectId: "project-a",
          },
          {
            taskId: "main-session",
            workspacePath: "/workspace",
            projectId: "project-b",
          },
          {
            taskId: "main-session",
            workspacePath: "/workspace",
            workspaceIdentity: "ssh:other-source",
            projectId: "remote-project",
          },
        ],
      },
      groups: {
        parents: new Map([[JSON.stringify(["/workspace", "main-session"]), "group-b"]]),
      },
    };
    const view = renderWorkbench();
    const original = useWorkbenchTabsStore.getState().groups[0]!;
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const state = useWorkbenchTabsStore.getState();
    const draft = Object.values(state.tabs).find((tab) => tab.sessionId === null)!;
    expect(draft.projectId).toBe("project-b");
    expect(draft.taskGroupId).toBe("group-b");
    expect(draft.workspaceScope).toEqual(scope);
    expect(state.tabs[original.activeTabId]?.sessionId).toBe("main-session");
  });

  it("权威目录尚无任务归属时保留现有布局，提示后再尝试创建", () => {
    captured.directory = {
      factTree: { tasks: [] },
      groups: { parents: new Map() },
    };
    const view = renderWorkbench();
    const original = useWorkbenchTabsStore.getState().groups[0]!;
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-split-right"));
    expect(useWorkbenchTabsStore.getState().groups).toEqual([original]);
    expect(Object.keys(useWorkbenchTabsStore.getState().tabs)).toEqual([original.activeTabId]);
    expect(captured.toast).toHaveBeenCalledOnce();
    expect(captured.toast).toHaveBeenCalledWith("workbench.placementNotReady");
  });

  it("子会话返回已打开的父会话只聚焦父 Tab，保留两栏及子会话", () => {
    useWorkbenchTabsStore.getState().initialize(scope, "parent-session");
    const parentId = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    const childId = useWorkbenchTabsStore.getState().splitRight(scope);
    useWorkbenchTabsStore.getState().bindSession(childId, "child-session");
    renderWorkbench({ sessionId: "child-session" });
    act(() =>
      (captured.panes.get(childId)!.onBindSession as (id: string, session: string) => void)(
        childId,
        "parent-session",
      ),
    );
    const state = useWorkbenchTabsStore.getState();
    expect(state.groups).toHaveLength(2);
    expect(state.tabs[parentId]?.sessionId).toBe("parent-session");
    expect(state.tabs[childId]?.sessionId).toBe("child-session");
    expect(state.focusedGroupId).toBe(state.groups[0]!.id);
    expect(captured.mounts.get(parentId)).toBe(1);
    expect(captured.mounts.get(childId)).toBe(1);
  });

  it("SSH 连接换代时所有同身份后台 Tab 采用新 endpoint，保持 Tab 身份", () => {
    const oldScope = {
      workspacePath: "/remote",
      workspaceIdentity: "ssh:source:/remote",
      remoteSessionId: "endpoint-old",
    };
    useWorkbenchTabsStore.getState().initialize(oldScope, "first");
    const first = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    const second = useWorkbenchTabsStore.getState().splitRight(oldScope);
    useWorkbenchTabsStore.getState().bindSession(second, "second");
    renderWorkbench({
      ...oldScope,
      remoteSessionId: "endpoint-new",
      sessionId: "second",
    });
    const state = useWorkbenchTabsStore.getState();
    expect(Object.keys(state.tabs)).toEqual([first, second]);
    expect(state.tabs[first]?.workspaceScope.remoteSessionId).toBe("endpoint-new");
    expect(state.tabs[second]?.workspaceScope.remoteSessionId).toBe("endpoint-new");
    expect(captured.mounts.get(first)).toBe(1);
    expect(captured.mounts.get(second)).toBe(1);
  });

  it("右侧草稿 accepted 原地绑定，不覆盖左侧且不会重新挂载", () => {
    const view = renderWorkbench();
    const leftId = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const rightId = useWorkbenchTabsStore.getState().groups[1]!.activeTabId;
    expect(useWorkbenchTabsStore.getState().tabs[rightId]?.draftId).toBeTruthy();
    act(() =>
      (captured.panes.get(rightId)!.onBindSession as (id: string, session: string) => void)(
        rightId,
        "right-session",
      ),
    );
    view.rerender(
      createElement(V4WorkspaceChatArea, {
        ...scope,
        sessionId: "right-session",
      }),
    );
    expect(useWorkbenchTabsStore.getState().tabs[leftId]?.sessionId).toBe("main-session");
    expect(useWorkbenchTabsStore.getState().tabs[rightId]?.sessionId).toBe("right-session");
    expect(captured.mounts.get(leftId)).toBe(1);
    expect(captured.mounts.get(rightId)).toBe(1);
  });

  it("换栏和交换只改位置，保留每个 Tab 的本地编辑内容", () => {
    const view = renderWorkbench();
    const leftId = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const state = useWorkbenchTabsStore.getState();
    const rightId = state.groups[1]!.activeTabId;
    fireEvent.change(view.getByLabelText(`draft-${rightId}`), {
      target: { value: "右侧未发送" },
    });
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-swap-groups"));
    expect(view.getByLabelText<HTMLInputElement>(`draft-${rightId}`).value).toBe("右侧未发送");
    act(() => useWorkbenchTabsStore.getState().moveTab(rightId, state.groups[0]!.id, 1));
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(1);
    expect(useWorkbenchTabsStore.getState().tabs[leftId]?.sessionId).toBe("main-session");
    expect(view.getByLabelText<HTMLInputElement>(`draft-${rightId}`).value).toBe("右侧未发送");
    expect(captured.mounts.get(rightId)).toBe(1);
  });

  it("迁移旧 pane 所有权，关闭迁移出的右栏不复活旧布局", () => {
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/other" },
      sessionId: "right-session",
    });
    const view = renderWorkbench();
    expect(usePaneLayoutStore.getState().panes).toEqual({});
    const rightId = useWorkbenchTabsStore.getState().groups[1]!.activeTabId;
    act(() => useWorkbenchTabsStore.getState().activateTab(rightId));
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-close-view"));
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(1);
    expect(usePaneLayoutStore.getState().root).toEqual(INITIAL_PANE_LAYOUT.root);
  });

  it("首次恢复以工作台焦点为准，不被旧 shell 会话覆盖", () => {
    useWorkbenchTabsStore.getState().initialize(scope, "restored-left");
    useWorkbenchTabsStore.getState().splitRight({
      workspacePath: "/remote",
      workspaceIdentity: "remote:ssh:host:/remote",
      remoteSessionId: "ssh-1",
    });
    const restoredId = useWorkbenchTabsStore.getState().groups[1]!.activeTabId;
    const onPaneActiveSessionChange = vi.fn();
    renderWorkbench({ onPaneActiveSessionChange });
    expect(useWorkbenchTabsStore.getState().groups[1]!.activeTabId).toBe(restoredId);
    expect(onPaneActiveSessionChange).toHaveBeenCalledWith(
      {
        workspacePath: "/remote",
        workspaceIdentity: "remote:ssh:host:/remote",
        remoteSessionId: "ssh-1",
      },
      null,
    );
  });

  it("关闭最后 Tab 创建独立草稿，不发停止命令", () => {
    const view = renderWorkbench();
    const original = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    openLayoutMenu(view);
    fireEvent.click(view.getByTestId("workbench-close-view"));
    const state = useWorkbenchTabsStore.getState();
    expect(state.groups).toHaveLength(1);
    expect(state.tabs[state.groups[0]!.activeTabId]?.sessionId).toBeNull();
    expect(state.tabs[original]).toBeUndefined();
  });

  it("紧凑历史客户端沿用单 pane，不消费桌面布局", () => {
    const view = renderWorkbench({ compactForRemoteControl: true });
    expect(view.queryByTestId("workbench-split-right")).toBeNull();
    expect(captured.panes.has(V4_PRIMARY_PANE_ID)).toBe(true);
    expect(useWorkbenchTabsStore.getState().groups).toEqual([]);
  });
});
