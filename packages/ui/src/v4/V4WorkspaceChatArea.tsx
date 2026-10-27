import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { V4_PRIMARY_PANE_ID, type PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { FULL_WORKBENCH_RECT, SPLIT_VAR_PREFIX, type RectExpr } from "@/v4/workbenchLayout.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchSplitDivider } from "@/v4/WorkbenchSplitDivider.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useWorkbenchTabsStore, useWorkbenchTabNavigation } from "@/v4/workbench-tabs/index.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface V4WorkspaceChatAreaProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop；Web / 手机远控保留 UI 行为但不触发该事件。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  allowEscapeStopOutsidePane?: boolean;
  /** Settings 等覆盖层打开时为 false，隐藏 Pane 不得消费一次性 Composer 请求。 */
  foregroundEnabled?: boolean;
  remoteSessionId?: string;
  compactForRemoteControl?: boolean;
  /** primary pane 绑定的 CLI session（既有选择态 activeTaskId）；null = draft。 */
  sessionId: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  /** primary pane createSession/fork 后接入既有选择路径（handleSelectTask）。 */
  onSessionCreated?: (sessionId: string) => void;
  /** primary pane 会话删除后回 draft（shell 起新草稿）。 */
  onSessionDeleted?: () => void;
  /**
   * 草稿态 composer contextHeader（m5：workspace 菜单 + Git 分支），
   * 仅下发给 primary pane——其余 pane 的 draft 不承载壳级 workspace 切换。
   */
  draftComposerHeader?: ReactNode;
  /** 桌面轻量草稿标题栏复用主草稿 composer 的 drop controller。 */
  onPrimaryDraftDropTargetControllerChange?: (
    controller: ConversationDropTargetController | null,
  ) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string | null) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/** 布局只改共同父节点下的矩形；Tab 的稳定身份不会随换栏改变。 */
export function V4WorkspaceChatArea(props: V4WorkspaceChatAreaProps) {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    sessionId,
    compactForRemoteControl = false,
    foregroundEnabled = true,
    onPaneActiveSessionChange,
  } = props;
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({ workspacePath, workspaceIdentity, remoteSessionId }),
    [workspacePath, workspaceIdentity, remoteSessionId],
  );
  const shellWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const groups = useWorkbenchTabsStore((state) => state.groups);
  const tabs = useWorkbenchTabsStore((state) => state.tabs);
  const focusedGroupId = useWorkbenchTabsStore((state) => state.focusedGroupId);
  const ratio = useWorkbenchTabsStore((state) => state.ratio);
  const activateTab = useWorkbenchTabsStore((state) => state.activateTab);
  const closeTab = useWorkbenchTabsStore((state) => state.closeTab);
  useWorkbenchTabNavigation({
    scope,
    sessionId,
    enabled: !compactForRemoteControl,
    onActiveChange: onPaneActiveSessionChange,
  });
  const { intl } = useZCodeIntl();
  const { presentation } = useConversationPanePresentation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 760);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const singleVisibleGroup = narrow || presentation === "floating";
  const shell = useMemo<WorkbenchShellBinding>(
    () => ({ ...props, activeSessionId: sessionId }),
    [props, sessionId],
  );
  const focusGroup = useCallback((groupId: string) => {
    const group = useWorkbenchTabsStore.getState().groups.find((item) => item.id === groupId);
    if (group) useWorkbenchTabsStore.getState().activateTab(group.activeTabId);
  }, []);
  const bindSession = useCallback((tabId: string, createdSessionId: string) => {
    const state = useWorkbenchTabsStore.getState();
    const current = state.tabs[tabId];
    const existing = current?.sessionId
      ? Object.values(state.tabs).find(
          (tab) =>
            tab.id !== tabId &&
            tab.sessionId === createdSessionId &&
            (tab.workspaceScope.workspaceIdentity?.trim() || tab.workspaceScope.workspacePath) ===
              (current.workspaceScope.workspaceIdentity?.trim() ||
                current.workspaceScope.workspacePath),
        )
      : null;
    // 已有会话中的返回父会话属于导航；不能按草稿 accepted 合并掉父、子两个 Tab。
    if (existing) state.activateTab(existing.id);
    else state.bindSession(tabId, createdSessionId);
    return false;
  }, []);
  const confirmRestoredTab = useCallback((tabId: string) => {
    const state = useWorkbenchTabsStore.getState();
    const tab = state.tabs[tabId];
    if (tab?.sessionId) state.bindSession(tabId, tab.sessionId);
  }, []);
  const commitRatio = useCallback(
    (_splitId: string, value: number) => useWorkbenchTabsStore.getState().setRatio(value),
    [],
  );
  const containerStyle = {
    [`${SPLIT_VAR_PREFIX}workbench-tabs`]: String(ratio),
  } as CSSProperties;
  const groupRect = (index: number): RectExpr =>
    singleVisibleGroup || groups.length === 1
      ? FULL_WORKBENCH_RECT
      : index === 0
        ? {
            left: "0%",
            top: "0%",
            width: "100% * var(--v4-split-workbench-tabs)",
            height: "100%",
          }
        : {
            left: "100% * var(--v4-split-workbench-tabs)",
            top: "0%",
            width: "100% * (1 - var(--v4-split-workbench-tabs))",
            height: "100%",
          };
  if (compactForRemoteControl)
    return (
      <div className="relative h-full min-h-0 w-full">
        <WorkbenchLeafPane
          paneId={V4_PRIMARY_PANE_ID}
          rect={FULL_WORKBENCH_RECT}
          focused={foregroundEnabled}
          showFocusIndicator={false}
          shellWorkspaceKey={shellWorkspaceKey}
          binding={null}
          shell={shell}
          onFocusRequest={() => {}}
          onClosePane={() => {}}
          onConfirmRestoredSession={() => {}}
          onBindSession={(_id, created) => props.onSessionCreated?.(created)}
        />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="conversation-workbench">
      {singleVisibleGroup && groups.length > 1 ? (
        <div className="flex shrink-0 gap-1 border-b border-border p-1">
          {groups.map((group, index) => (
            <Button
              key={group.id}
              variant={group.id === focusedGroupId ? "secondary" : "ghost"}
              size="sm"
              data-testid={`workbench-switch-group-${group.id}`}
              onClick={() => focusGroup(group.id)}
            >
              {intl.formatMessage({
                id: index === 0 ? "workbench.leftGroup" : "workbench.rightGroup",
              })}
            </Button>
          ))}
        </div>
      ) : null}
      <div ref={containerRef} style={containerStyle} className="relative min-h-0 flex-1">
        {Object.values(tabs).map((tab) => {
          const groupIndex = groups.findIndex((group) => group.tabIds.includes(tab.id));
          const group = groups[groupIndex];
          if (!group) return null;
          const active = group.activeTabId === tab.id;
          const hidden = !active || (singleVisibleGroup && group.id !== focusedGroupId);
          const rect = groupRect(groupIndex);
          return (
            <WorkbenchLeafPane
              key={tab.id}
              paneId={tab.id}
              groupId={group.id}
              groupActive={active}
              groupIndex={groupIndex}
              rect={rect}
              hidden={hidden}
              focused={foregroundEnabled && !hidden && group.id === focusedGroupId}
              showFocusIndicator={groups.length > 1 && !singleVisibleGroup}
              shellWorkspaceKey={shellWorkspaceKey}
              binding={tab}
              tabBinding={tab}
              shell={shell}
              onFocusRequest={activateTab}
              onClosePane={closeTab}
              onConfirmRestoredSession={confirmRestoredTab}
              onBindSession={bindSession}
            />
          );
        })}
        {groups.length === 2 && !singleVisibleGroup ? (
          <WorkbenchSplitDivider
            containerRef={containerRef}
            splitId="workbench-tabs"
            direction="row"
            ratio={ratio}
            regionFraction={1}
            style={{
              left: "calc(100% * var(--v4-split-workbench-tabs))",
              top: 0,
              height: "100%",
              width: "9px",
              transform: "translateX(-50%)",
            }}
            onCommitRatio={commitRatio}
          />
        ) : null}
      </div>
    </div>
  );
}
