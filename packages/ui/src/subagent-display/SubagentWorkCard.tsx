import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  LoaderIcon,
  SquareIcon,
} from "lucide-react";
import {
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_WORK_CARD,
  TID_V4_SUBAGENT_WORK_CARD_MEMBER,
  TID_V4_SUBAGENT_WORK_CARD_STOP,
  TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
  TID_V4_SUBAGENT_WORK_CARD_TOGGLE,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { openSubagentSessionFromSummary } from "@/v4/ConversationAgentToolCallRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { AgentSpawnGroupRenderItem } from "./contract.js";
import {
  buildSubagentAvatarIndex,
  buildSubagentWorkCardModel,
  formatSubagentDuration,
  isSubagentStatusActive,
  resolveSubagentAvatarIndexes,
  type SubagentWorkCardMember,
} from "./model.js";
import { describeAgentSpawnMember } from "./spawnGroups.js";
import { SubagentFace } from "./SubagentFace.js";

const SUBAGENT_KNOWN_EFFORT_VALUES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

const EMPTY_AVATAR_INDEX = buildSubagentAvatarIndex(undefined);
// 折叠/展开只属于 renderer 内存（与旧派发行同一模式）：虚拟列表重挂不丢，刷新即重置。
const workCardOpenState = new Map<string, boolean>();

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

function pluralId(base: string, count: number): string {
  return `${base}.${count === 1 ? "one" : "other"}`;
}

function elapsedOf(
  startedAt: number | undefined,
  endedAt: number | undefined,
  active: boolean,
  now: number,
): number | undefined {
  if (startedAt === undefined) return undefined;
  if (active) return Math.max(0, now - startedAt);
  return endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined;
}

function StopButton({
  label,
  text,
  dataTestId,
  onClick,
}: {
  label: string;
  text: string;
  dataTestId: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={dataTestId}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 px-1.5 text-ui-sm text-foreground"
    >
      <SquareIcon aria-hidden className="size-3 fill-current" />
      {text}
    </Button>
  );
}

function MemberRow({
  member,
  isLast,
  now,
  canOpen,
  canStop,
  formatMessage,
  onOpen,
  onStop,
}: {
  member: SubagentWorkCardMember;
  isLast: boolean;
  now: number;
  canOpen: boolean;
  canStop: boolean;
  formatMessage: FormatMessage;
  onOpen: (member: SubagentWorkCardMember) => void;
  onStop: (workId: string) => void;
}) {
  const active = isSubagentStatusActive(member.status);
  const statusText = formatMessage({ id: `subagentDisplay.status.${member.status}` });
  const elapsedMs = elapsedOf(member.startedAt, member.endedAt, active, now);
  const elapsed = elapsedMs === undefined ? null : formatSubagentDuration(elapsedMs, formatMessage);
  // 档位与输入区弹层同口径本地化（复用 engine.effort.* 文案键），未知取值保留原文。
  const effortValue = member.effort?.toLowerCase();
  const effortText =
    effortValue && SUBAGENT_KNOWN_EFFORT_VALUES.has(effortValue)
      ? formatMessage({ id: `engine.effort.${effortValue}` })
      : member.effort;
  const modelText = member.model
    ? effortText
      ? `${member.model} ${effortText}`
      : member.model
    : null;
  const steps =
    member.toolCallCount !== undefined
      ? formatMessage(
          { id: pluralId("subagentDisplay.workCard.steps", member.toolCallCount) },
          { count: String(member.toolCallCount) },
        )
      : null;
  const detail = [member.taskSummary, steps].filter(Boolean).join(" · ");
  const rowTestId =
    canOpen && member.childSessionId
      ? testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, member.childSessionId)
      : testId(TID_V4_SUBAGENT_WORK_CARD_MEMBER, member.toolCallId);
  return (
    <li className="relative pl-5">
      {/* 树形连接线：竖线贯穿到下一成员，最后一个只画到本行中线（└）。 */}
      <span
        aria-hidden
        className={cn("absolute left-2 top-0 w-px bg-border", isLast ? "h-4" : "bottom-0")}
      />
      <span aria-hidden className="absolute left-2 top-4 h-px w-2.5 bg-border" />
      <div className="flex min-w-0 items-start gap-1 rounded-lg transition-colors hover:bg-hover">
        <button
          type="button"
          data-testid={rowTestId}
          data-child-session-id={member.childSessionId}
          data-subagent-status={member.status}
          disabled={!canOpen}
          aria-label={formatMessage(
            {
              id: canOpen
                ? "subagentDisplay.spawnRow.openMember"
                : "subagentDisplay.workCard.memberLabel",
            },
            { name: member.name, status: statusText },
          )}
          onClick={() => onOpen(member)}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:cursor-default"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <SubagentFace
                avatarIndex={member.avatarIndex}
                name={member.name}
                size={16}
                status={member.status}
                subagentType={member.subagentType}
              />
              <span
                className="min-w-0 truncate text-ui-base font-medium text-foreground"
                title={member.name}
              >
                {member.name}
              </span>
            </span>
            {modelText ? (
              <span
                data-subagent-model
                className="ml-auto max-w-full truncate text-ui-sm text-foreground-subtle"
                title={modelText}
              >
                {modelText}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-sm text-foreground-subtle">
            <span className={cn(member.status === "failed" && "text-destructive")}>
              {statusText}
              {elapsed ? ` · ${elapsed}` : ""}
            </span>
          </span>
          {detail ? (
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle" title={detail}>
              {detail}
            </span>
          ) : null}
          {member.resultSummary ? (
            <span
              className="min-w-0 truncate text-ui-sm text-foreground-subtle"
              title={member.resultSummary}
            >
              {formatMessage(
                { id: "subagentDisplay.workCard.reason" },
                { reason: member.resultSummary },
              )}
            </span>
          ) : null}
        </button>
        {canStop && member.stopWorkId && member.childSessionId ? (
          <StopButton
            dataTestId={testId(TID_V4_SUBAGENT_WORK_CARD_STOP, member.childSessionId)}
            label={formatMessage(
              { id: "subagentDisplay.workCard.stopLabel" },
              { name: member.name },
            )}
            text={formatMessage({ id: "subagentDisplay.workCard.stop" })}
            onClick={() => onStop(member.stopWorkId!)}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * 对话行内 Subagent 工作卡（docs/desktop/multi-agent-display-spec.md「对话行内 Subagent 工作卡」）。
 * 只读父会话投影（subagent 行 + live 索引）；打开复用 `onOpenSubagentSession`，停止复用
 * `onCancelBackgroundWork`（父会话 cancelBackgroundWork）。折叠态只在 Renderer 内存。
 */
export function SubagentWorkCard({
  item,
  context,
}: {
  item: AgentSpawnGroupRenderItem;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const model = useMemo(() => {
    const facts = item.members.map(describeAgentSpawnMember);
    const indexes = resolveSubagentAvatarIndexes(
      context.subagentAvatarIndex ?? EMPTY_AVATAR_INDEX,
      facts.map((member) => member.childSessionId),
    );
    return buildSubagentWorkCardModel(
      facts.map((member, position) => ({
        ...member,
        avatarIndex: indexes[position]!,
        fallbackName: intl.formatMessage(
          { id: "subagentDisplay.fallbackName" },
          { index: String(indexes[position]! + 1) },
        ),
      })),
      context.subagentWorkLiveIndex,
    );
  }, [context.subagentAvatarIndex, context.subagentWorkLiveIndex, intl, item.members]);

  const firstToolCallId = model.members[0]?.toolCallId ?? "";
  // 运行阶段的手动展开不能带到结束阶段，否则虚拟列表重挂后不会默认折叠。
  const openStateKey = `${item.turnId}\0${firstToolCallId}\0${model.active ? "active" : "ended"}`;
  const [, updateOpenState] = useState(0);
  const open = workCardOpenState.get(openStateKey) ?? null;
  const setOpen = useCallback(
    (next: boolean) => {
      workCardOpenState.set(openStateKey, next);
      updateOpenState((version) => version + 1);
    },
    [openStateKey],
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!model.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [model.active]);

  const cancel = context.onCancelBackgroundWork;
  const openMember = useCallback(
    (member: SubagentWorkCardMember) => {
      // 与 Agent 卡同一请求与可见标题；为空时由右侧 tab 回退"子智能体"，不传类型或编号兜底。
      openSubagentSessionFromSummary({
        childSessionId: member.childSessionId,
        context,
        subagentType: member.subagentType,
        title: member.title,
      });
    },
    [context],
  );
  const stopAll = useCallback(() => {
    // D7：逐个调用既有幂等命令；runtime 是唯一所有者，不新增 stop-all 协议命令。
    for (const workId of model.stopAllWorkIds) cancel?.(workId);
  }, [cancel, model.stopAllWorkIds]);

  const total = model.members.length;
  const collapsed = !(open ?? model.active);
  const elapsedMs = elapsedOf(model.startedAt, model.endedAt, model.active, now);
  const elapsed = elapsedMs === undefined ? null : formatSubagentDuration(elapsedMs, formatMessage);
  const canOpenAny = Boolean(context.sessionId && context.onOpenSubagentSession);
  const toggleLabel = formatMessage({
    id: collapsed ? "subagentDisplay.workCard.expand" : "subagentDisplay.workCard.collapse",
  });
  const toggleTestId = testId(TID_V4_SUBAGENT_WORK_CARD_TOGGLE, String(item.rowId));

  const endedCounts = (["failed", "cancelled"] as const)
    .filter((status) => model.counts[status] > 0)
    .map((status) =>
      formatMessage(
        { id: `subagentDisplay.count.${status}` },
        { count: String(model.counts[status]) },
      ),
    );
  const endedSummaryText = [
    formatMessage(
      { id: pluralId("subagentDisplay.workCard.summary", total) },
      {
        count: String(total),
        duration: elapsed ?? formatSubagentDuration(0, formatMessage),
      },
    ),
    ...endedCounts,
  ].join(" · ");

  const activeStates = (
    ["pending", "running", "waiting", "blocked", "done", "failed", "cancelled"] as const
  ).flatMap((status) => {
    const count = model.members.filter((member) => member.status === status).length;
    return count > 0
      ? [`${formatMessage({ id: `subagentDisplay.status.${status}` })} ${count}`]
      : [];
  });
  const summaryText = model.active
    ? [formatMessage({ id: "subagentDisplay.workCard.title" }), ...activeStates, elapsed]
        .filter(Boolean)
        .join(" · ")
    : endedSummaryText;
  const hasRunning = model.members.some(
    (member) => member.status === "running" || member.status === "pending",
  );

  return (
    <div
      data-conversation-selectable="true"
      data-row-id={item.rowId}
      data-testid={testId(TID_V4_SUBAGENT_WORK_CARD, String(item.rowId))}
      data-state={model.active ? "running" : "ended"}
      data-member-count={total}
      className="flex min-w-0 flex-col rounded-xl border border-border bg-surface text-ui-base"
    >
      {collapsed ? (
        <button
          type="button"
          data-testid={toggleTestId}
          aria-expanded={false}
          aria-label={`${summaryText}，${toggleLabel}`}
          onClick={() => setOpen(true)}
          className="flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-foreground-subtle transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          {model.active ? (
            hasRunning ? (
              <LoaderIcon
                aria-hidden
                className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <ClockIcon aria-hidden className="size-4 shrink-0" />
            )
          ) : model.counts.failed > 0 ? (
            <CircleXIcon aria-hidden className="size-4 shrink-0 text-destructive" />
          ) : model.counts.cancelled > 0 ? (
            <SquareIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{summaryText}</span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0" />
        </button>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                <span className="truncate">
                  {formatMessage({
                    id: model.active
                      ? "subagentDisplay.workCard.title"
                      : "subagentDisplay.workCard.titleEnded",
                  })}
                </span>
                {model.active ? (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning motion-reduce:animate-none"
                  />
                ) : null}
              </p>
              <p className="truncate text-ui-sm text-foreground-subtle tabular-nums">
                {formatMessage(
                  { id: pluralId("subagentDisplay.workCard.subtitle", total) },
                  { count: String(total), ended: String(model.endedCount) },
                )}
                {elapsed ? ` · ${elapsed}` : ""}
              </p>
            </div>
            {model.active && cancel && model.stopAllWorkIds.length > 0 ? (
              <StopButton
                dataTestId={testId(TID_V4_SUBAGENT_WORK_CARD_STOP_ALL, String(item.rowId))}
                label={formatMessage({ id: "subagentDisplay.workCard.stopAllLabel" })}
                text={formatMessage({ id: "subagentDisplay.workCard.stopAll" })}
                onClick={stopAll}
              />
            ) : null}
            {
              <button
                type="button"
                data-testid={toggleTestId}
                aria-expanded
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={() => setOpen(false)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <ChevronRightIcon aria-hidden className="size-4 rotate-90" />
              </button>
            }
          </div>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
            <BotIcon aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
            <span className="shrink-0 font-medium text-foreground">
              {formatMessage({ id: "subagentDisplay.workCard.mainAgent" })}
            </span>
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
              {formatMessage(
                {
                  id: pluralId(
                    model.active
                      ? "subagentDisplay.workCard.coordinating"
                      : "subagentDisplay.workCard.coordinated",
                    total,
                  ),
                },
                { count: String(total) },
              )}
            </span>
          </div>
          <ul className="ml-1 flex min-w-0 flex-col">
            {model.members.map((member, position) => (
              <MemberRow
                key={member.key}
                member={member}
                isLast={position === total - 1}
                now={now}
                canOpen={canOpenAny && Boolean(member.childSessionId)}
                canStop={Boolean(cancel)}
                formatMessage={formatMessage}
                onOpen={openMember}
                onStop={(workId) => cancel?.(workId)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
