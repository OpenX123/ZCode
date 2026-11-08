import type { ComponentType, ReactNode } from "react";
import { buildSessionDeepLink } from "@zcode/shared/session-navigation";
import { useSessionForkAction } from "@/hooks/useZCodeTaskService.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { workbenchWorkspaceKey, type WorkbenchSessionBinding } from "./contract.js";
import { useWorkbenchTabsStore } from "./store.js";
import { openSessionNavigation } from "./openSessionNavigation.js";

interface MenuItemProps {
  children: ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

/** 右键菜单与下拉菜单的子菜单原语不能混用（Radix 依赖各自的 Root context），按宿主菜单选择。 */
export type SessionMenuKind = "context" | "dropdown";

const SUB_MENU_PRIMITIVES = {
  context: { Sub: ContextMenuSub, Trigger: ContextMenuSubTrigger, Content: ContextMenuSubContent },
  dropdown: {
    Sub: DropdownMenuSub,
    Trigger: DropdownMenuSubTrigger,
    Content: DropdownMenuSubContent,
  },
} as const;

/** 列表、置顶、分组和标题菜单共用会话动作；布局与 CLI 事实分属各自所有者。 */
export function WorkbenchSessionMenuItems({
  binding,
  intl,
  Item,
  Separator,
  disabled = false,
  disabledReason,
  showLayoutActions = true,
  menuKind = "context",
}: {
  binding: WorkbenchSessionBinding;
  intl: { formatMessage: (desc: { id: string }) => string };
  Item: ComponentType<MenuItemProps>;
  Separator: ComponentType<{ key?: string }>;
  disabled?: boolean;
  disabledReason?: string;
  showLayoutActions?: boolean;
  menuKind?: SessionMenuKind;
}) {
  const enabled = useV4SplitPaneEntry().enabled;
  const forkAction = useSessionForkAction(binding.workspaceScope, binding.sessionId);
  const addTab = useOptionalTabStore((state) => state.addTab);
  const tabs = useWorkbenchTabsStore((state) => state.tabs);
  const groups = useWorkbenchTabsStore((state) => state.groups);
  const workspaceKey = workbenchWorkspaceKey(binding.workspaceScope);
  const tab = Object.values(tabs).find(
    (item) =>
      item.sessionId === binding.sessionId &&
      workbenchWorkspaceKey(item.workspaceScope) === workspaceKey,
  );
  const groupIndex = tab ? groups.findIndex((group) => group.tabIds.includes(tab.id)) : -1;
  if (!binding.sessionId) return null;
  const SubMenu = SUB_MENU_PRIMITIVES[menuKind];
  const forkDisabled = disabled || Boolean(binding.readOnly) || forkAction.pending;
  const open = (side: "left" | "right") => {
    if (!disabled) useWorkbenchTabsStore.getState().openSession(binding, side);
  };
  const copyLink = async () => {
    try {
      const scope = binding.workspaceScope;
      const remote = useRemoteWorkspaceSessionStore.getState();
      const endpoint = scope.remoteSessionId
        ? remote.sessionsById[scope.remoteSessionId]
        : Object.values(remote.sessionsById).find(
            (session) =>
              scope.workspaceIdentity && session.workspaceIdentity === scope.workspaceIdentity,
          );
      const link = buildSessionDeepLink({
        taskId: binding.sessionId!,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(endpoint?.sourceServerId ? { sourceServerId: endpoint.sourceServerId } : {}),
      });
      await navigator.clipboard.writeText(link);
      toast(intl.formatMessage({ id: "sessionAction.linkCopied" }));
    } catch (error) {
      logger.warn("[session-actions] 复制会话链接失败", error);
      toast(
        `${intl.formatMessage({ id: "sessionAction.copyFailed" })}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const fork = async (mode: "same-directory" | "worktree") => {
    if (forkDisabled) return;
    try {
      const result = await forkAction.fork(mode);
      useZCodeSessionStore
        .getState()
        .bumpTaskListVersion(result.workspacePath, result.workspaceIdentity);
      openSessionNavigation(
        {
          workspaceScope: {
            workspacePath: result.workspacePath,
            workspaceIdentity: result.workspaceIdentity,
            remoteSessionId: binding.workspaceScope.remoteSessionId,
          },
          sessionId: result.taskId,
        },
        addTab,
        enabled,
      );
      forkAction.complete();
      if (result.forkKind === "handoff")
        toast(intl.formatMessage({ id: "sessionAction.handoffCreated" }));
    } catch (error) {
      logger.warn("[session-actions] 分叉会话失败", error);
      toast(
        `${intl.formatMessage({ id: "sessionAction.forkFailed" })}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  return (
    <>
      <Item
        data-testid="session-copy-link"
        onSelect={() => {
          void copyLink();
        }}
      >
        {intl.formatMessage({ id: "sessionAction.copyLink" })}
      </Item>
      {/* 分叉与“分栏”同构：一个主项收纳两种分叉方式，挂起时主项提示进度并整体禁用。 */}
      <SubMenu.Sub>
        <SubMenu.Trigger
          data-testid="session-fork-submenu"
          disabled={forkDisabled}
          title={disabledReason}
        >
          {intl.formatMessage({
            id: forkAction.pending ? "sessionAction.forking" : "sessionAction.fork",
          })}
        </SubMenu.Trigger>
        <SubMenu.Content className="w-52">
          <Item
            data-testid="session-fork-same-directory"
            disabled={forkDisabled}
            title={disabledReason}
            onSelect={() => {
              void fork("same-directory");
            }}
          >
            {intl.formatMessage({ id: "sessionAction.forkSameDirectory" })}
          </Item>
          <Item
            data-testid="session-fork-worktree"
            disabled={forkDisabled}
            title={disabledReason}
            onSelect={() => {
              void fork("worktree");
            }}
          >
            {intl.formatMessage({ id: "sessionAction.forkWorktree" })}
          </Item>
        </SubMenu.Content>
      </SubMenu.Sub>
      <Separator />
      {enabled && showLayoutActions ? (
        <>
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="workbench-submenu">
              {intl.formatMessage({ id: "workbench.layoutMenu" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              <Item
                data-testid="workbench-open-in-left"
                disabled={disabled}
                title={disabledReason}
                onSelect={() => open("left")}
              >
                {intl.formatMessage({ id: "workbench.openInLeft" })}
              </Item>
              <Item
                data-testid="workbench-open-in-right"
                disabled={disabled}
                title={disabledReason}
                onSelect={() => open("right")}
              >
                {intl.formatMessage({ id: "workbench.openInRight" })}
              </Item>
              {tab ? (
                <Item
                  data-testid="workbench-move-to-other-group"
                  disabled={disabled}
                  title={disabledReason}
                  onSelect={() => open(groupIndex === 1 ? "left" : "right")}
                >
                  {intl.formatMessage({ id: "workbench.moveToOtherGroup" })}
                </Item>
              ) : null}
              {groups.length === 2 ? (
                <Item
                  data-testid="workbench-swap-groups"
                  onSelect={() => useWorkbenchTabsStore.getState().swapGroups()}
                >
                  {intl.formatMessage({ id: "workbench.swapGroups" })}
                </Item>
              ) : null}
              {tab ? (
                <Item
                  data-testid="workbench-close-view"
                  onSelect={() => useWorkbenchTabsStore.getState().closeTab(tab.id)}
                >
                  {intl.formatMessage({ id: "workbench.closeView" })}
                </Item>
              ) : null}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <Separator />
        </>
      ) : null}
    </>
  );
}
