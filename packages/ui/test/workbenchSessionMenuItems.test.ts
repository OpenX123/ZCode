// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
import { V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

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
function renderCommonMenu(sessionId = "session", disabled = false) {
  const file = { loading: false, path: null, exists: false };
  return render(
    createElement(
      V4SplitPaneEntryProvider,
      { enabled: true },
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
        ...taskActions,
      }),
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
});
afterEach(cleanup);

describe("侧栏会话工作台右键操作", () => {
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
