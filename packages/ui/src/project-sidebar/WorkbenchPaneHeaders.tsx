import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  remoteHostIdFromWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
} from "@zcode/shared";
import { TID_WORKSPACE_PATH } from "@zcode/shared/test-ids";
import { WorkspaceHeaderTitleSection } from "@/WorkspaceHeaderSections.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getTaskMeta } from "@/store/zcodeSessionStoreSelectors.js";
import {
  useWorkbenchTabsStore,
  workbenchWorkspaceKey,
  type WorkbenchTab,
} from "@/v4/workbench-tabs/index.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";

export interface WorkbenchPaneHeadersProps {
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  allowRemoteWorkspace?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  leadingPaddingClassName?: string | false;
}

function WorkbenchPaneHeader({
  tab,
  focused,
  showClose,
  onCreateTask,
  allowRemoteWorkspace,
  onOpenRemoteWorkspace,
}: WorkbenchPaneHeadersProps & { tab: WorkbenchTab; focused: boolean; showClose: boolean }) {
  const { intl } = useZCodeIntl();
  const directory = useOptionalProjectDirectory();
  const workspaceKey = workbenchWorkspaceKey(tab.workspaceScope);
  const cachedTask = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace && tab.sessionId ? getTaskMeta(workspace, tab.sessionId) : undefined;
  });
  const task = tab.sessionId
    ? directory?.factTree.tasks.find(
        (item) =>
          item.taskId === tab.sessionId &&
          (item.workspaceIdentity?.trim() || item.workspacePath) === workspaceKey,
      )
    : undefined;
  const projectId = tab.sessionId ? task?.projectId : tab.projectId;
  const hostId =
    task?.hostId ?? remoteHostIdFromWorkspaceIdentity(tab.workspaceScope.workspaceIdentity ?? "");
  const project = directory?.projects.find(
    (item) => item.id === projectId && (!hostId || item.hostId === hostId),
  );
  const title = tab.sessionId
    ? cachedTask?.title || task?.title || intl.formatMessage({ id: "taskList.untitled" })
    : intl.formatMessage({ id: "workbench.newConversation" });
  const provider: ZCodeProvider = cachedTask?.provider ?? task?.provider ?? ZCODE_AGENT_PROVIDER;
  const projectLabel =
    project?.name ??
    intl.formatMessage({
      id: tab.sessionId ? "chat.empty.workOutsideProject" : "chat.empty.selectProject",
    });
  const selectOutsideProject = () => {
    const source = useWorkbenchTabsStore.getState().tabs[tab.id];
    if (!source || source.sessionId !== null) return;
    onCreateTask({
      projectId: null,
      replaceDraftTabId: tab.id,
      taskGroupId: source.taskGroupId,
      isCurrent: () => useWorkbenchTabsStore.getState().tabs[tab.id] === source,
    });
  };
  const leading = (
    <>
      <span
        data-workbench-project=""
        data-testid={focused ? TID_WORKSPACE_PATH : undefined}
        data-workspace-abs-path={tab.workspaceScope.workspacePath}
        className="min-w-0 max-w-[45%] shrink text-ui-base text-foreground-subtle"
        title={tab.workspaceScope.workspacePath}
      >
        {tab.sessionId === null && directory ? (
          <ProjectComposerMenu
            {...tab.workspaceScope}
            draftTabId={tab.id}
            menuSide="bottom"
            onCreateTask={onCreateTask}
            onSelectConversationWorkspace={selectOutsideProject}
            allowRemoteWorkspace={allowRemoteWorkspace}
            onOpenRemoteWorkspace={onOpenRemoteWorkspace}
            allowConversationWorkspaceDetach={false}
            triggerClassName="h-7 max-w-full px-1 text-ui-base"
            containerClassName="max-w-full rounded-md"
          />
        ) : (
          <span className="block truncate">{projectLabel}</span>
        )}
      </span>
      <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
        ·
      </span>
    </>
  );
  return (
    <div
      data-testid={`workbench-pane-header-${tab.id}`}
      data-workbench-header-tab-id={tab.id}
      data-focused={focused}
      onPointerDownCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-workbench-close]"))
          useWorkbenchTabsStore.getState().activateTab(tab.id);
      }}
      onFocusCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-workbench-close]"))
          useWorkbenchTabsStore.getState().activateTab(tab.id);
      }}
      className="flex h-full min-w-0 items-center gap-1"
    >
      <div data-workbench-title="" className="min-w-0 flex-1 overflow-hidden">
        <WorkspaceHeaderTitleSection
          variant={tab.sessionId ? "task" : "draft"}
          workspaceAbsPath={tab.workspaceScope.workspacePath}
          workspaceIdentity={tab.workspaceScope.workspaceIdentity}
          remoteSessionId={tab.workspaceScope.remoteSessionId}
          projectName={projectLabel}
          activeTaskTitle={title}
          activeTaskId={tab.sessionId}
          activeSessionId={tab.sessionId}
          activeTraceId={null}
          activeTaskProvider={provider}
          resolvedActiveTaskMeta={task ?? cachedTask}
          workspaceHeaderState={{ selectedProvider: provider }}
          gitDirtyFileCount={0}
          selectedEditor={null}
          onRefreshGit={() => {}}
          sessionLogPath={null}
          nativeSessionLogProvider={null}
          nativeSessionLogPath={null}
          nativeSessionLogExists={false}
          nativeSessionLogLoading={false}
          providerWorkspaceConfigPath={null}
          providerWorkspaceConfigExists={false}
          providerWorkspaceConfigLoading={false}
          compact
          leadingContent={leading}
          hideWorkspaceContext
          showDraftTitle
        />
      </div>
      {showClose ? (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid={`workbench-close-pane-${tab.id}`}
          data-workbench-close=""
          aria-label={intl.formatMessage({ id: "workbench.closePane" })}
          className="shrink-0 [app-region:no-drag]"
          onClick={() => {
            const state = useWorkbenchTabsStore.getState();
            const source = state.groups.find((group) => group.tabIds.includes(tab.id));
            const target = state.groups.find((group) => group.id !== source?.id);
            // 关闭一栏只收起布局；整栏绑定原子迁入另一栏，保留目标当前会话和全部未发送草稿。
            if (source && target)
              state.moveTab(source.tabIds, target.id, target.tabIds.length, {
                preserveTargetActive: true,
              });
          }}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

/** 标题与正文共用工作台比例和绑定，工具栏仍由外层 Header 只渲染一份。 */
export function WorkbenchPaneHeaders(props: WorkbenchPaneHeadersProps) {
  const groups = useWorkbenchTabsStore((state) => state.groups);
  const tabs = useWorkbenchTabsStore((state) => state.tabs);
  const focusedGroupId = useWorkbenchTabsStore((state) => state.focusedGroupId);
  const ratio = useWorkbenchTabsStore((state) => state.ratio);
  const { presentation } = useConversationPanePresentation();
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 760);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const single = narrow || presentation === "floating" || groups.length < 2;
  const visible = single ? groups.filter((group) => group.id === focusedGroupId) : groups;
  return (
    <div ref={ref} className="flex h-full min-w-0 w-full">
      {visible.map((group, index) => {
        const tab = tabs[group.activeTabId];
        return tab ? (
          <div
            key={group.id}
            data-workbench-header-group={group.id}
            className={cn(
              "h-full min-w-0 shrink-0 px-2",
              index === 0 && props.leadingPaddingClassName,
            )}
            style={{
              width: single ? "100%" : `${(index === 0 ? ratio : 1 - ratio) * 100}%`,
              paddingRight:
                index === visible.length - 1
                  ? "var(--workbench-header-actions-width, 12rem)"
                  : undefined,
            }}
          >
            <WorkbenchPaneHeader
              {...props}
              tab={tab}
              focused={group.id === focusedGroupId}
              showClose={groups.length > 1}
            />
          </div>
        ) : null;
      })}
    </div>
  );
}
