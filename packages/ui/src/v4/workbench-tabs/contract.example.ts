import type { WorkbenchTabsActions, WorkbenchWorkspaceScope } from "./contract.js";

export function exampleConversationWorkbench(
  actions: WorkbenchTabsActions,
  scope: WorkbenchWorkspaceScope,
): void {
  actions.initialize(scope);
  const tabId = actions.splitRight(scope);
  // 改选项目沿用草稿身份和未提交内容，首发绑定后该操作自动拒绝。
  actions.newDraft(scope, { replaceDraftTabId: tabId, projectId: "selected-project" });
  // Runtime 接纳首发后只绑定身份，输入仍沿原会话命令链路提交。
  actions.bindSession(tabId, "accepted-session");
  actions.activateTab(tabId);
  // 侧栏的显式定向打开保留同一会话绑定；普通点击仍只聚焦现有位置。
  actions.openSession({ workspaceScope: scope, sessionId: "accepted-session" }, "left");
}

export function exampleCloseWorkbenchPane(
  actions: WorkbenchTabsActions,
  sourceTabIds: readonly string[],
  targetGroupId: string,
  targetTabCount: number,
): void {
  // 关闭分栏只原子合入视图，保留目标当前会话和全部未发送草稿。
  actions.moveTab(sourceTabIds, targetGroupId, targetTabCount, { preserveTargetActive: true });
}
