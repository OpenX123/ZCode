import { ArrowLeftRight, Columns2 } from "lucide-react";
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
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getTaskMeta } from "@/store/zcodeSessionStoreSelectors.js";
import {
  getFocusedWorkbenchTab,
  useWorkbenchTabsStore,
  workbenchWorkspaceKey,
  type WorkbenchTab,
} from "@/v4/workbench-tabs/index.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

function WorkbenchViewItem({ tab, label }: { tab: WorkbenchTab; label: string }) {
  const { intl } = useZCodeIntl();
  const title = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workbenchWorkspaceKey(tab.workspaceScope)];
    return workspace && tab.sessionId ? getTaskMeta(workspace, tab.sessionId)?.title : undefined;
  });
  return (
    <DropdownMenuItem
      data-testid={`workbench-activate-tab-${tab.id}`}
      onSelect={() => useWorkbenchTabsStore.getState().activateTab(tab.id)}
      title={tab.workspaceScope.workspacePath}
    >
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span className="truncate">
        {title ||
          (tab.sessionId
            ? tab.sessionId.slice(0, 8)
            : intl.formatMessage({ id: "workbench.newConversation" }))}
      </span>
    </DropdownMenuItem>
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
          {groups.flatMap((group, index) =>
            group.tabIds.map((id) =>
              tabs[id] ? (
                <WorkbenchViewItem
                  key={id}
                  tab={tabs[id]}
                  label={intl.formatMessage({
                    id: index === 0 ? "workbench.leftGroup" : "workbench.rightGroup",
                  })}
                />
              ) : null,
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
