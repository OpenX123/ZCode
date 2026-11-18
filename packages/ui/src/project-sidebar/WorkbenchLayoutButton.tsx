import { ArrowLeftRight, Columns2 } from "lucide-react";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useWorkbenchSessionTitle } from "@/project-sidebar/useWorkbenchSessionTitle.js";
import {
  getFocusedWorkbenchTab,
  useWorkbenchTabsStore,
  workbenchWorkspaceKey,
  type WorkbenchTab,
} from "@/v4/workbench-tabs/index.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

function WorkbenchViewItem({ tab, focused }: { tab: WorkbenchTab; focused: boolean }) {
  const title = useWorkbenchSessionTitle(tab);
  const projectName = useWorkbenchTabProjectName(tab);
  return (
    <DropdownMenuItem
      data-testid={`workbench-activate-tab-${tab.id}`}
      data-marquee-hover-root=""
      data-focused={focused ? "true" : undefined}
      className={cn(focused && "bg-accent text-accent-foreground")}
      onSelect={() => {
        const state = useWorkbenchTabsStore.getState();
        const current = state.tabs[tab.id];
        const groupIndex = state.groups.findIndex((group) => group.tabIds.includes(tab.id));
        // 菜单展开期间连接可能换代或视图已关闭；必须重读 owner，不能回写旧 endpoint 或复活旧 Tab。
        if (!current || groupIndex < 0) return;
        // 已在右栏只聚焦，避免 openSession 的移动语义将其重排到后台草稿之后。
        if (current.sessionId && groupIndex !== 1) state.openSession(current, "right");
        else state.activateTab(current.id);
      }}
    >
      {/* 修复：标题原为 whitespace-normal，长标题折行使列表错乱；改为单行并在悬停时走马灯展示全文。
          “左栏/右栏”前缀对选择会话无信息量，已移除；当前聚焦会话用高亮区分。 */}
      <TaskTitleOverflowText as="span">{title}</TaskTitleOverflowText>
      {projectName ? (
        <span className="max-w-[40%] shrink-0 truncate text-ui-sm text-foreground-subtle">
          {projectName}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

/** 与 WorkbenchPaneHeaders 一致：会话按完整身份查归属项目，草稿用 Tab 自身的 projectId。 */
function useWorkbenchTabProjectName(tab: WorkbenchTab): string | null {
  const directory = useOptionalProjectDirectory();
  if (!directory) return null;
  const workspaceKey = workbenchWorkspaceKey(tab.workspaceScope);
  const task = tab.sessionId
    ? directory.factTree.tasks.find(
        (item) =>
          item.taskId === tab.sessionId &&
          (item.workspaceIdentity?.trim() || item.workspacePath) === workspaceKey,
      )
    : undefined;
  const projectId = tab.sessionId ? task?.projectId : tab.projectId;
  if (!projectId) return null;
  const hostId =
    task?.hostId ?? remoteHostIdFromWorkspaceIdentity(tab.workspaceScope.workspaceIdentity ?? "");
  return (
    directory.projects.find((item) => item.id === projectId && (!hostId || item.hostId === hostId))
      ?.name ?? null
  );
}

/** 视图入口只提交工作台导航；关闭和合栏均不改变 Runtime 的运行状态。 */
export function WorkspaceWorkbenchLayoutButton({
  useWindowsCaptionSpacing = false,
}: {
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const projectDirectory = useOptionalProjectDirectory();
  const groups = useWorkbenchTabsStore((state) => state.groups);
  const tabs = useWorkbenchTabsStore((state) => state.tabs);
  const focusedGroupId = useWorkbenchTabsStore((state) => state.focusedGroupId);
  if (!groups.length) return null;
  const single = groups.length === 1;
  const split = () => {
    const state = useWorkbenchTabsStore.getState();
    const active = getFocusedWorkbenchTab(state);
    if (!active) return;
    const workspaceKey = workbenchWorkspaceKey(active.workspaceScope);
    // 同目录可属于多个项目：按完整会话身份继承归属，不能按 cwd 猜项目。
    const task = active.sessionId
      ? projectDirectory?.factTree.tasks.find(
          (item) =>
            item.taskId === active.sessionId &&
            (item.workspaceIdentity?.trim() || item.workspacePath) === workspaceKey,
        )
      : null;
    if (active.sessionId && projectDirectory && !task) {
      toast(intl.formatMessage({ id: "workbench.placementNotReady" }));
      return;
    }
    state.splitRight(active.workspaceScope, {
      projectId: task ? task.projectId : active.projectId,
      taskGroupId: active.sessionId
        ? (projectDirectory?.groups.parents.get(JSON.stringify([workspaceKey, active.sessionId])) ??
          active.taskGroupId)
        : active.taskGroupId,
    });
  };
  const merge = () => {
    const state = useWorkbenchTabsStore.getState();
    const [left, right] = state.groups;
    if (!left || !right) return;
    // 合栏一次提交，避免逐个移动时覆盖剩余栏当前会话并反复切换焦点。
    state.moveTab(right.tabIds, left.id, left.tabIds.length, { preserveTargetActive: true });
  };
  return (
    <div className="flex items-center [app-region:no-drag]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid="workbench-layout-menu"
            aria-label={intl.formatMessage({ id: "workbench.layoutMenu" })}
            className={cn(useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS)}
          >
            <Columns2 className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
          {single ? (
            <DropdownMenuItem data-testid="workbench-split-right" onSelect={split}>
              <Columns2 className="size-4" />
              {intl.formatMessage({ id: "workbench.splitRight" })}
            </DropdownMenuItem>
          ) : null}
          {!single ? (
            <>
              <DropdownMenuItem
                data-testid="workbench-swap-groups"
                onSelect={() => useWorkbenchTabsStore.getState().swapGroups()}
              >
                <ArrowLeftRight className="size-4" />
                {intl.formatMessage({ id: "workbench.swapGroups" })}
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="workbench-merge-groups" onSelect={merge}>
                {intl.formatMessage({ id: "workbench.mergeGroups" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="workbench-move-to-other-group"
                onSelect={() => {
                  const state = useWorkbenchTabsStore.getState();
                  const active = getFocusedWorkbenchTab(state);
                  const other = state.groups.find((group) => group.id !== state.focusedGroupId);
                  if (active && other) state.moveTab(active.id, other.id, other.tabIds.length);
                }}
              >
                {intl.formatMessage({ id: "workbench.moveToOtherGroup" })}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem
            data-testid="workbench-close-view"
            onSelect={() => {
              const state = useWorkbenchTabsStore.getState();
              const active = getFocusedWorkbenchTab(state);
              if (active) state.closeTab(active.id);
            }}
          >
            {intl.formatMessage({ id: "workbench.closeView" })}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{intl.formatMessage({ id: "workbench.openViews" })}</DropdownMenuLabel>
          {groups.flatMap((group) =>
            group.tabIds.map((id) =>
              tabs[id] ? (
                <WorkbenchViewItem
                  key={id}
                  tab={tabs[id]}
                  focused={group.id === focusedGroupId && group.activeTabId === id}
                />
              ) : null,
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
