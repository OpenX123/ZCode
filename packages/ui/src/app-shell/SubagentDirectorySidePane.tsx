import { memo, useEffect, useMemo, useState } from "react";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import {
  TID_V4_SUBAGENT_DIRECTORY,
  TID_V4_SUBAGENT_DIRECTORY_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import {
  buildSubagentAvatarIndex,
  resolveSubagentAvatarIndexes,
  SubagentFace,
  type SubagentDisplayStatus,
} from "@/subagent-display/index.js";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

export function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

function StatusIcon({ status }: { status: DirectoryItem["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
    case "success":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "cancelled":
      return <BanIcon aria-hidden className={className} />;
    case "lost":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

const FACE_STATUS: Record<DirectoryItem["status"], SubagentDisplayStatus> = {
  running: "running",
  waiting: "waiting",
  blocked: "blocked",
  success: "done",
  failed: "failed",
  cancelled: "cancelled",
  lost: "failed",
};

const DirectoryRow = memo(function DirectoryRow({
  avatarIndex,
  item,
  onOpen,
}: {
  avatarIndex: number;
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  return (
    <button
      type="button"
      data-testid={testId(TID_V4_SUBAGENT_DIRECTORY_ITEM, item.childSessionId)}
      data-subagent-status={item.status}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => onOpen(item)}
    >
      <SubagentFace
        avatarIndex={avatarIndex}
        name={item.title}
        size={20}
        status={FACE_STATUS[item.status]}
        subagentType={item.subagentType}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{item.title}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtlest">
            <StatusIcon status={item.status} />
            {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
          </span>
        </span>
        {item.summary ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {item.summary}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(timestamp, intl)}
        </span>
      ) : null}
    </button>
  );
});

/** 详情左上角返回：回到当前父会话目录（同一 Tab，清除选择）。 */
export function buildSubagentDirectoryBackRequest(
  tab: SubagentDirectorySidePaneTab,
): OpenScopedSubagentDirectorySideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
  };
}

/**
 * 每个 root 唯一的"子智能体"Tab（docs/desktop/multi-agent-display-spec.md「右侧"子智能体"Tab」）：
 * Tab 上没有选择时显示目录，选中某个子会话时显示其只读详情（左上角返回目录）。
 * 视图只由 Tab 字段决定，切换都经 `workspaceSidePane.ts` 的唯一写入路径。
 */
export const SubagentDirectorySidePane = memo(function SubagentDirectorySidePane({
  tab,
  focused = false,
  visible = true,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onOpenBackgroundBash,
}: {
  tab: SubagentDirectorySidePaneTab;
  focused?: boolean;
  visible?: boolean;
  compactForRemoteControl?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
}) {
  const detail = useMemo(
    () =>
      tab.childSessionId
        ? {
            // 详情 SessionPane 的 paneId 按子会话区分，切换选中项时不复用上一个子会话的 pane 状态。
            id: `${tab.id}:${tab.childSessionId}`,
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
            ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
            rootSessionId: tab.rootSessionId,
            parentSessionId: tab.parentSessionId,
            childSessionId: tab.childSessionId,
            subagentType: tab.subagentType ?? "",
            title: tab.title ?? "",
          }
        : null,
    [
      tab.childSessionId,
      tab.id,
      tab.parentSessionId,
      tab.remoteSessionId,
      tab.rootSessionId,
      tab.subagentType,
      tab.title,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );
  const handleBack = useMemo(
    () =>
      onOpenSubagentDirectory
        ? () => onOpenSubagentDirectory(buildSubagentDirectoryBackRequest(tab))
        : undefined,
    [onOpenSubagentDirectory, tab],
  );
  if (detail) {
    return (
      <SubagentSessionSidePane
        key={detail.childSessionId}
        tab={detail}
        focused={focused}
        visible={visible}
        compactForRemoteControl={compactForRemoteControl}
        onBack={handleBack}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenBackgroundBash={onOpenBackgroundBash}
      />
    );
  }
  return <SubagentDirectoryView tab={tab} onOpenSubagentSession={onOpenSubagentSession} />;
});

const SubagentDirectoryView = memo(function SubagentDirectoryView({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
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
      <SubagentDirectoryContents tab={tab} onOpenSubagentSession={onOpenSubagentSession} />
    </V4PaneConversationProvider>
  );
});

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const endedTotal = subagents?.endedTotal ?? 0;
  const avatarIndex = useMemo(
    () => buildSubagentAvatarIndex(subagents?.childSessionIds),
    [subagents?.childSessionIds],
  );
  const runningIndexes = resolveSubagentAvatarIndexes(
    avatarIndex,
    running.map((item) => item.childSessionId),
  );
  const endedIndexes = resolveSubagentAvatarIndexes(
    avatarIndex,
    directory.ended.items.map((item) => item.childSessionId),
  );
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };

  return (
    <div
      data-testid={TID_V4_SUBAGENT_DIRECTORY}
      data-parent-session-id={tab.parentSessionId}
      className="flex size-full min-h-0 flex-col bg-background"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "subagentDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.running" })} · {running.length}
          </h3>
          {running.length > 0 ? (
            running.map((item, position) => (
              <DirectoryRow
                key={item.childSessionId}
                avatarIndex={runningIndexes[position]!}
                item={item}
                onOpen={handleOpen}
              />
            ))
          ) : (
            <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.runningEmpty" })}
            </p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} · {endedTotal}
          </h3>
          {directory.ended.items.map((item, position) => (
            <DirectoryRow
              key={item.childSessionId}
              avatarIndex={endedIndexes[position]!}
              item={item}
              onOpen={handleOpen}
            />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p role="alert" className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]">
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
