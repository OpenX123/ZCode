// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
import { V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { parseSessionDeepLink } from "@zcode/shared/session-navigation";

const actions = vi.hoisted(() => ({
  fork: vi.fn(),
  toast: vi.fn(),
  addTab: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@/hooks/useZCodeTaskService.js", () => ({
  useSessionForkAction: () => ({ pending: false, fork: actions.fork, complete: vi.fn() }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: actions.toast }));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: (select: (state: { addTab: typeof actions.addTab }) => unknown) =>
    select({ addTab: actions.addTab }),
}));

function Item({
  children,
  onSelect,
  ...props
}: {
  children?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  title?: string;
  "data-testid"?: string;
}) {
  return createElement("button", { ...props, onClick: onSelect }, children);
}
const Separator = () => createElement("hr");
vi.mock("@/components/ui/context-menu.js", () => ({
  ContextMenuContent: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  ContextMenuItem: (props: ComponentProps<typeof Item>) => createElement(Item, props),
  ContextMenuSeparator: () => createElement("hr"),
  ContextMenuSub: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  ContextMenuSubContent: ({ children }: { children: ReactNode }) =>
    createElement("div", {}, children),
  ContextMenuSubTrigger: (props: ComponentProps<typeof Item>) => createElement(Item, props),
}));
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenuSub: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-menu-kind": "dropdown" }, children),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) =>
    createElement("div", {}, children),
  DropdownMenuSubTrigger: (props: ComponentProps<typeof Item>) => createElement(Item, props),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  SidebarNativeTooltip: ({ children }: { children: ReactNode }) => children,
}));
const intl = { formatMessage: ({ id }: { id: string }) => id };
const scope = { workspacePath: "/project" };
const taskActions = {
  onTogglePinTask: vi.fn(),
  onStartRenameTask: vi.fn(),
  onArchiveTask: vi.fn(),
  onMarkTaskAsUnread: vi.fn(),
  onOpenTaskPathInFileManager: vi.fn(),
  onCopyWorkspacePath: vi.fn(),
  onCopyTaskPath: vi.fn(),
  onCopyTaskLogPath: vi.fn(),
  onOpenProviderConfig: vi.fn(),
};
function renderCommonMenu(
  sessionId = "session",
  disabled = false,
  enabled = true,
  menuKind?: "context" | "dropdown",
) {
  const file = { loading: false, path: null, exists: false };
  return render(
    createElement(
      V4SplitPaneEntryProvider,
      { enabled },
      createElement(TaskActionMenuContent, {
        workbenchSession: { workspaceScope: scope, sessionId },
        intl,
        Item,
        Separator,
        isPinned: false,
        fileManagerLabel: "Finder",
        taskSessionFile: file,
        taskNativeSessionLogFile: file,
        providerConfigFile: file,
        disableTaskActions: disabled,
        ...(menuKind ? { menuKind } : {}),
        ...taskActions,
      }),
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: actions.copy.mockResolvedValue(undefined) },
  });
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
});
afterEach(cleanup);

describe("侧栏会话工作台右键操作", () => {
  it("关闭分栏后仍可复制会话链接；链接只包含稳定坐标", async () => {
    const { getByTestId, queryByTestId } = renderCommonMenu("中文 session", false, false);
    expect(queryByTestId("workbench-submenu")).toBeNull();
    fireEvent.click(getByTestId("session-copy-link"));
    await waitFor(() => expect(actions.copy).toHaveBeenCalledTimes(1));
    expect(parseSessionDeepLink(actions.copy.mock.calls[0]![0])).toEqual({
      taskId: "中文 session",
      workspacePath: scope.workspacePath,
    });
    expect(getByTestId("session-fork-same-directory")).toBeTruthy();
    expect(getByTestId("session-fork-worktree")).toBeTruthy();
  });
  it("分叉与分栏同构：一个“分叉”主项收纳当前目录与新工作树两个子项", () => {
    const { getByTestId } = renderCommonMenu();
    const trigger = getByTestId("session-fork-submenu");
    expect(trigger.textContent).toBe("sessionAction.fork");
    const sub = trigger.parentElement!;
    expect(sub.contains(getByTestId("session-fork-same-directory"))).toBe(true);
    expect(sub.contains(getByTestId("session-fork-worktree"))).toBe(true);
    expect(getByTestId("session-fork-same-directory").textContent).toBe(
      "sessionAction.forkSameDirectory",
    );
  });
  it("受限会话禁用分叉主项，不展开子项动作", () => {
    const { getByTestId } = renderCommonMenu("session", true);
    expect(getByTestId("session-fork-submenu").hasAttribute("disabled")).toBe(true);
  });
  it("标题栏下拉菜单使用 Dropdown 子菜单原语承载分叉", async () => {
    actions.fork.mockResolvedValue({ taskId: "child", workspacePath: "/project" });
    const { getByTestId } = renderCommonMenu("session", false, true, "dropdown");
    const sub = getByTestId("session-fork-submenu").parentElement!;
    expect(sub.getAttribute("data-menu-kind")).toBe("dropdown");
    fireEvent.click(getByTestId("session-fork-same-directory"));
    await waitFor(() => expect(actions.fork).toHaveBeenCalledWith("same-directory"));
  });
  it("工作树分叉打开返回的精确 child scope；不自动提交输入", async () => {
    const result = {
      taskId: "child",
      workspacePath: "/worktrees/child",
      workspaceIdentity: "ssh:child",
      forkKind: "handoff",
    };
    actions.fork.mockResolvedValue(result);
    const { getByTestId } = renderCommonMenu();
    fireEvent.click(getByTestId("session-fork-worktree"));
    await waitFor(() =>
      expect(actions.addTab).toHaveBeenCalledWith(result.workspacePath, {
        workspaceIdentity: result.workspaceIdentity,
        remoteSessionId: undefined,
      }),
    );
    const state = useWorkbenchTabsStore.getState();
    const child = Object.values(state.tabs).find((tab) => tab.sessionId === result.taskId);
    expect(child?.workspaceScope).toEqual({
      workspacePath: result.workspacePath,
      workspaceIdentity: result.workspaceIdentity,
      remoteSessionId: undefined,
    });
    expect(
      useZCodeSessionStore
        .getState()
        .getWorkspaceState(result.workspacePath, result.workspaceIdentity).activeTaskId,
    ).toBe(result.taskId);
    expect(actions.fork).toHaveBeenCalledWith("worktree");
    expect(actions.toast).toHaveBeenCalledWith("sessionAction.handoffCreated");
  });
  it("分叉失败展示具体错误，并保留源会话导航", async () => {
    actions.fork.mockRejectedValue(new Error("502 Bad Gateway"));
    useWorkbenchTabsStore.getState().initialize(scope, "session");
    const { getByTestId } = renderCommonMenu();
    fireEvent.click(getByTestId("session-fork-same-directory"));
    await waitFor(() =>
      expect(actions.toast).toHaveBeenCalledWith("sessionAction.forkFailed: 502 Bad Gateway"),
    );
    expect(actions.addTab).not.toHaveBeenCalled();
    expect(Object.values(useWorkbenchTabsStore.getState().tabs)[0]?.sessionId).toBe("session");
  });
  it("普通列表菜单在右栏打开独立会话，保留左侧草稿并不执行任务动作", () => {
    useWorkbenchTabsStore.getState().initialize(scope);
    const left = useWorkbenchTabsStore.getState().groups[0]!;
    const { getByTestId } = renderCommonMenu();
    fireEvent.click(getByTestId("workbench-open-in-right"));
    const state = useWorkbenchTabsStore.getState();
    expect(state.groups[0]).toEqual(left);
    expect(state.tabs[state.groups[1]!.activeTabId]?.sessionId).toBe("session");
    for (const action of Object.values(taskActions)) expect(action).not.toHaveBeenCalled();
  });
  it("移动、交换和关闭视图只改变导航，保留会话绑定直到显式关闭", () => {
    useWorkbenchTabsStore.getState().initialize(scope, "session");
    const { getByTestId } = renderCommonMenu();
    fireEvent.click(getByTestId("workbench-move-to-other-group"));
    const right = useWorkbenchTabsStore.getState().groups[1]!;
    fireEvent.click(getByTestId("workbench-swap-groups"));
    expect(useWorkbenchTabsStore.getState().groups[0]?.id).toBe(right.id);
    fireEvent.click(getByTestId("workbench-close-view"));
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(1);
    expect(
      Object.values(useWorkbenchTabsStore.getState().tabs).every((tab) => tab.sessionId === null),
    ).toBe(true);
    for (const action of Object.values(taskActions)) expect(action).not.toHaveBeenCalled();
  });
  it("受限任务禁止打开和移动，但关闭已打开视图仍可用", () => {
    useWorkbenchTabsStore.getState().initialize(scope, "session");
    const { getByTestId } = renderCommonMenu("session", true);
    fireEvent.click(getByTestId("workbench-open-in-right"));
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(1);
    fireEvent.click(getByTestId("workbench-close-view"));
    expect(Object.values(useWorkbenchTabsStore.getState().tabs)[0]?.sessionId).toBeNull();
  });
  it("分组菜单按完整identity打开远端，关闭同名远端会话不影响本地", () => {
    useWorkbenchTabsStore.getState().initialize(scope, "same-id");
    const task = {
      taskId: "same-id",
      workspacePath: scope.workspacePath,
      workspaceIdentity: "ssh:other",
      title: "Remote",
      provider: "openai",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    } as ComponentProps<typeof GroupedTaskContextMenuContent>["task"];
    const file = { loading: false, path: null };
    const { getByTestId } = render(
      createElement(
        V4SplitPaneEntryProvider,
        { enabled: true },
        createElement(GroupedTaskContextMenuContent, {
          task,
          remoteSessionId: "endpoint",
          groups: [],
          intl,
          fileManagerLabel: "Finder",
          taskSessionFile: file,
          taskNativeSessionLogFile: file,
          providerConfigFile: file,
          onMoveTaskToGroup: vi.fn(),
          onMoveTaskToTop: vi.fn(),
          onCopyText: vi.fn(),
          ...taskActions,
        }),
      ),
    );
    fireEvent.click(getByTestId("workbench-open-in-right"));
    const state = useWorkbenchTabsStore.getState();
    expect(state.tabs[state.groups[1]!.activeTabId]?.workspaceScope).toEqual({
      ...scope,
      workspaceIdentity: "ssh:other",
      remoteSessionId: "endpoint",
    });
    fireEvent.click(getByTestId("workbench-close-view"));
    expect(Object.values(useWorkbenchTabsStore.getState().tabs)).toHaveLength(1);
    expect(Object.values(useWorkbenchTabsStore.getState().tabs)[0]?.workspaceScope).toEqual(scope);
    expect(Object.values(useWorkbenchTabsStore.getState().tabs)[0]?.sessionId).toBe("same-id");
  });
});
