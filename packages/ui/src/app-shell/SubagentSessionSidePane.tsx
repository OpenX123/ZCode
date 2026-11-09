import { memo, useMemo } from "react";
import { TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SubagentSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SubagentSessionHeader } from "@/subagent-display/index.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

export const SubagentSessionSidePane = memo(function SubagentSessionSidePane({
  tab,
  focused,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  compactForRemoteControl?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <div className="flex size-full min-h-0 flex-col">
        {/* 头部只读父/子投影（头像、状态、耗时、可停时的父会话停止），与引擎无关。 */}
        <SubagentSessionHeader tab={tab} />
        <div className="min-h-0 flex-1">
          <SessionPane
            paneId={tab.id}
            sessionId={tab.childSessionId}
            openTrigger="subagent"
            rootSessionId={tab.rootSessionId}
            readOnly
            allowWorkspaceFileRewind
            compactForRemoteControl={compactForRemoteControl}
            focused={focused}
            workspacePath={tab.workspacePath}
            workspaceIdentity={tab.workspaceIdentity}
            remoteSessionId={tab.remoteSessionId}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenSubagentSession={onOpenSubagentSession}
            onOpenBackgroundBash={onOpenBackgroundBash}
          />
        </div>
        {/* 子会话只读：输入区位置换成一行说明（docs/desktop/multi-agent-display-spec.md「右侧详情」）。 */}
        <p
          data-testid={TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT}
          className="shrink-0 border-t border-border px-4 py-2.5 text-center text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage({ id: "subagentDisplay.sidePane.readOnlyHint" })}
        </p>
      </div>
    </V4PaneConversationProvider>
  );
});
