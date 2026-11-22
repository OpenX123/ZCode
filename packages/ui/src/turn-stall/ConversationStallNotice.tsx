import { useEffect, useMemo, useState } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStallNoticeProps } from "./contract.js";
import { STALL_TICK_MS, resolveConversationStallState } from "./model.js";

/**
 * 运行中轮次末尾的无响应提示（docs/chat/turn-stall-indicator.md），只用于 `waiting_model`；
 * 工具执行耗时由运行中的工具行自身显示（`useRunningToolElapsedLabel`）。
 * 只在 turnActivity 存在且轮次运行时自行计时；不持有业务状态，按钮全部委托宿主。
 */
export function ConversationStallNotice({
  turnActivity,
  running,
  hasPendingInteraction,
  engineLabel,
  onInterruptAndRetry,
  onInterrupt,
  onViewLogs,
}: ConversationStallNoticeProps) {
  const { intl } = useZCodeIntl();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ticking = running && Boolean(turnActivity);

  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), STALL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const stall = useMemo(
    () => resolveConversationStallState({ turnActivity, running, hasPendingInteraction, nowMs }),
    [hasPendingInteraction, nowMs, running, turnActivity],
  );

  if (stall.kind === "none") return null;

  const message = intl.formatMessage(
    { id: stall.idleMinutes === 1 ? "chat.stall.idle.one" : "chat.stall.idle.other" },
    { engine: engineLabel, minutes: stall.idleMinutes },
  );
  const phaseLabel = intl.formatMessage({ id: "chat.stall.phase.waitingModel" });

  if (stall.level === "hint") {
    return (
      <div
        data-testid="conversation-stall-notice"
        data-stall-kind="hint"
        className="flex items-center gap-2 py-1 text-ui-sm text-foreground-subtle"
      >
        <ClockIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {message} · {phaseLabel}
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="conversation-stall-notice"
      data-stall-kind="warning"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warning-surface px-3 py-2 text-ui-base text-warning-surface-foreground"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0">
          {message} · {phaseLabel}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {onViewLogs ? (
          <Button type="button" size="sm" variant="ghost" onClick={onViewLogs}>
            {intl.formatMessage({ id: "chat.stall.viewLogs" })}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={onInterrupt}>
          {intl.formatMessage({ id: "chat.stall.interrupt" })}
        </Button>
        {onInterruptAndRetry ? (
          <Button
            type="button"
            size="sm"
            onClick={onInterruptAndRetry}
            data-testid="conversation-stall-retry"
          >
            {intl.formatMessage({ id: "chat.stall.interruptAndRetry" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
