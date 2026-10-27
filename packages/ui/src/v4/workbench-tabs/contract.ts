/** 工作台仅持有窗口导航与草稿身份，不拥有会话事实或已接受输入。 */
export interface WorkbenchWorkspaceScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
}

export interface WorkbenchSessionBinding {
  readonly workspaceScope: WorkbenchWorkspaceScope;
  readonly sessionId: string | null;
  readonly readOnly?: boolean;
  readonly restoredUnvalidated?: boolean;
}

export interface WorkbenchTab extends WorkbenchSessionBinding {
  readonly id: string;
  /** 首发绑定 session 后仍保留，用于完成草稿到会话的原地交接。 */
  readonly draftId?: string;
  readonly projectId?: string | null;
  readonly taskGroupId?: string | null;
  readonly inheritRootDraft?: boolean;
}

export interface WorkbenchTabGroup {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeTabId: string;
}

export interface WorkbenchTabsSnapshot {
  readonly groups: readonly WorkbenchTabGroup[];
  readonly tabs: Readonly<Record<string, WorkbenchTab>>;
  readonly focusedGroupId: string;
  readonly ratio: number;
}

export interface WorkbenchDraftOptions {
  readonly groupId?: string;
  /** 原地改选未发送草稿的工作区和归属；失效或已绑定会话时不新建。 */
  readonly replaceDraftTabId?: string;
  readonly projectId?: string | null;
  readonly taskGroupId?: string | null;
  /** 仅 Root 已暂存的新建输入可交接旧根草稿，普通分屏草稿保持独立。 */
  readonly inheritRootDraft?: boolean;
}

export interface WorkbenchTabsActions {
  /** 空工作台的一次性初始化；已有恢复态时保持原样。 */
  initialize(
    scope: WorkbenchWorkspaceScope,
    sessionId?: string | null,
    options?: WorkbenchDraftOptions,
  ): void;
  /** 全工作台唯一会话；默认只聚焦原位置，显式 side 则原子移动或新建目标栏。 */
  openSession(binding: WorkbenchSessionBinding, side?: "left" | "right"): string;
  newDraft(scope: WorkbenchWorkspaceScope, options?: WorkbenchDraftOptions): string;
  /** 最多左右两栏；已有右栏时在右栏新增草稿。 */
  splitRight(scope: WorkbenchWorkspaceScope, options?: WorkbenchDraftOptions): string;
  activateTab(tabId: string): void;
  /** 移除源后按最终索引原子插入；批量移动保留传入顺序，可保留目标当前会话。 */
  moveTab(
    tabId: string | readonly string[],
    targetGroupId: string,
    targetIndex: number,
    options?: { readonly preserveTargetActive?: boolean },
  ): void;
  /** 只关闭视图；空栏合并，最后一页关闭后原工作区新建独立草稿。 */
  closeTab(tabId: string): void;
  swapGroups(): void;
  setRatio(ratio: number): void;
  /** accepted 后绑定原 Tab；同会话绑定可确认恢复态，不更换 id 或提交输入。 */
  bindSession(tabId: string, sessionId: string): void;
  /** 精确匹配 workspace 身份，刷新其全部 Tab；缺省 endpoint 不清除已有连接。 */
  refreshWorkspaceScope(scope: WorkbenchWorkspaceScope): void;
  /** 旧布局按顺序迁入左右栏，仅空工作台消费；旧 owner 由调用方随迁移清空。 */
  migrateLegacy(bindings: readonly WorkbenchSessionBinding[], ratio?: number): void;
}

export type WorkbenchTabsState = WorkbenchTabsSnapshot & WorkbenchTabsActions;
export type WorkbenchStorage = Pick<Storage, "getItem" | "setItem">;

export function workbenchWorkspaceKey(scope: WorkbenchWorkspaceScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

export function getFocusedWorkbenchTab(state: WorkbenchTabsSnapshot): WorkbenchTab | null {
  const group = state.groups.find((item) => item.id === state.focusedGroupId) ?? state.groups[0];
  return group ? (state.tabs[group.activeTabId] ?? null) : null;
}
