import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
  SquareIcon,
} from "lucide-react";
import {
  TID_V4_SUBAGENT_SESSION_HEADER,
  TID_V4_SUBAGENT_SESSION_STOP,
} from "@zcode/shared/test-ids";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import type { SubagentDisplayStatus } from "./contract.js";
import { buildSubagentSessionHeaderModel, isSubagentStatusActive } from "./model.js";
import { SubagentFace } from "./SubagentFace.js";

function useSessionProjection(sessionId: string) {
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  // 数据层按 session 引用计数：与 SessionPane、目录、状态面板共用同一订阅，不新建 transport。
  useEffect(() => {
    const nextLease = layer.acquire(sessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, sessionId]);
  return useConversationProjection(lease).snapshot;
}

function HeaderStatusIcon({ status }: { status: SubagentDisplayStatus }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "running":
      return (
        <LoaderCircleIcon
          aria-hidden
          className={`${className} animate-spin motion-reduce:animate-none`}
        />
      );
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
    case "done":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={`${className} text-destructive`} />;
    case "cancelled":
      return <BanIcon aria-hidden className={className} />;
    case "pending":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

function formatDuration(
  durationMs: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const total = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}${formatMessage({ id: "chat.summaryPanel.duration.hours" })}`);
  if (minutes > 0) {
    parts.push(`${minutes}${formatMessage({ id: "chat.summaryPanel.duration.minutes" })}`);
  }
  if (hours === 0 && (seconds > 0 || parts.length === 0)) {
    parts.push(`${seconds}${formatMessage({ id: "chat.summaryPanel.duration.seconds" })}`);
  }
  return parts.join(" ");
}

/**
 * 右侧子智能体详情头部（docs/desktop/multi-agent-display-spec.md「右侧详情」）：头像、名称、
 * 状态、耗时与可停时的停止。只读父/子会话投影，适用于任意引擎的 childSessionId。
 */
export function SubagentSessionHeader({ tab }: { tab: SubagentSessionSidePaneTab }) {
  const { intl } = useZCodeIntl();
  const { sendCommand } = useV4Conversation();
  const parentSnapshot = useSessionProjection(tab.parentSessionId);
  const childSnapshot = useSessionProjection(tab.childSessionId);
  const model = useMemo(
    () =>
      buildSubagentSessionHeaderModel({
        childSessionId: tab.childSessionId,
        subagentType: tab.subagentType,
        parent: parentSnapshot
          ? { subagents: parentSnapshot.subagents, backgroundWorks: parentSnapshot.backgroundWorks }
          : null,
        child: childSnapshot ? { control: childSnapshot.control, rows: childSnapshot.rows } : null,
      }),
    [childSnapshot, parentSnapshot, tab.childSessionId, tab.subagentType],
  );
  const active = isSubagentStatusActive(model.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || model.startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, model.startedAt]);

  const handleStop = useCallback(() => {
    if (!model.stopWorkId) return;
    // 停止只有一条路径：父会话既有的 cancelBackgroundWork {workId}，与状态面板 Stop 相同。
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: model.stopWorkId },
        sessionId: tab.parentSessionId,
      }),
    ).then(
      (ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[subagent-header] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      },
      (error: unknown) => {
        logger.warn(`[subagent-header] cancelBackgroundWork 发送失败: ${String(error)}`);
      },
    );
  }, [model.stopWorkId, sendCommand, tab.parentSessionId]);

  const name = tab.title?.trim() || intl.formatMessage({ id: "sidePane.subagent" });
  const elapsed =
    model.startedAt === undefined
      ? null
      : active
        ? formatBackgroundTaskElapsedLabel(Math.max(0, now - model.startedAt), intl.formatMessage)
        : model.endedAt !== undefined
          ? intl.formatMessage(
              { id: "subagentDisplay.header.took" },
              { duration: formatDuration(model.endedAt - model.startedAt, intl.formatMessage) },
            )
          : null;

  return (
    <header
      data-testid={TID_V4_SUBAGENT_SESSION_HEADER}
      data-child-session-id={tab.childSessionId}
      data-status={model.status ?? ""}
      data-face-variant={model.variant}
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-background px-4 py-2.5"
    >
      <SubagentFace
        animated={active}
        avatarIndex={model.avatarIndex}
        name={name}
        size={24}
        status={model.status}
        subagentType={tab.subagentType}
      />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-ui-base font-medium text-foreground" title={name}>
          {name}
        </h2>
        {model.status || elapsed ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-sm text-foreground-subtle">
            {model.status ? (
              <span className="inline-flex items-center gap-1">
                <HeaderStatusIcon status={model.status} />
                {intl.formatMessage({ id: `subagentDisplay.status.${model.status}` })}
              </span>
            ) : null}
            {model.status && elapsed ? <span aria-hidden>·</span> : null}
            {elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
          </p>
        ) : null}
      </div>
      {model.stopWorkId ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={TID_V4_SUBAGENT_SESSION_STOP}
          aria-label={intl.formatMessage({ id: "subagentDisplay.header.stopLabel" })}
          onClick={handleStop}
          className="shrink-0 px-1.5 text-ui-base text-foreground"
        >
          <SquareIcon aria-hidden className="size-3 fill-current" />
          {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
        </Button>
      ) : null}
    </header>
  );
}
