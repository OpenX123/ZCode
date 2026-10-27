import type { ComponentType, ReactNode } from "react";
import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { workbenchWorkspaceKey, type WorkbenchSessionBinding } from "./contract.js";
import { useWorkbenchTabsStore } from "./store.js";

interface MenuItemProps {
  children: ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

/** 列表、置顶和分组菜单共用视图命令；不触发任务事实或 Runtime 操作。 */
export function WorkbenchSessionMenuItems({
  binding,
  intl,
  Item,
  Separator,
  disabled = false,
  disabledReason,
}: {
  binding: WorkbenchSessionBinding;
  intl: { formatMessage: (desc: { id: string }) => string };
  Item: ComponentType<MenuItemProps>;
  Separator: ComponentType<{ key?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const enabled = useV4SplitPaneEntry().enabled;
  const tabs = useWorkbenchTabsStore((state) => state.tabs);
  const groups = useWorkbenchTabsStore((state) => state.groups);
  const workspaceKey = workbenchWorkspaceKey(binding.workspaceScope);
  const tab = Object.values(tabs).find(
    (item) =>
      item.sessionId === binding.sessionId &&
      workbenchWorkspaceKey(item.workspaceScope) === workspaceKey,
  );
  const groupIndex = tab ? groups.findIndex((group) => group.tabIds.includes(tab.id)) : -1;
  if (!enabled || !binding.sessionId) return null;
  const open = (side: "left" | "right") => {
    if (!disabled) useWorkbenchTabsStore.getState().openSession(binding, side);
  };
  return (
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
  );
}
