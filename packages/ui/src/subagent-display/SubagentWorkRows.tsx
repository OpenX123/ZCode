import { useCallback, useEffect, useMemo, useState } from "react";
import { SquareIcon } from "lucide-react";
import {
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_WORK_CARD,
  TID_V4_SUBAGENT_WORK_CARD_MEMBER,
  TID_V4_SUBAGENT_WORK_CARD_STOP,
  testId,
} from "@zcode/shared/test-ids";
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

const EMPTY_AVATAR_INDEX = buildSubagentAvatarIndex(undefined);

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

function memberStatusText(
  member: SubagentWorkCardMember,
  now: number,
  formatMessage: FormatMessage,
): string {
  const status = formatMessage({ id: `subagentDisplay.status.${member.status}` });
  // 只有真正在跑的成员带用时；等待确认 / 阻塞 / 等待启动只显示状态，避免把等待当成工作时长。
  if (member.status !== "running" || member.startedAt === undefined) return status;
  return `${status} · ${formatSubagentDuration(Math.max(0, now - member.startedAt), formatMessage)}`;
}

function SubagentWorkRow({
  member,
  now,
  canOpen,
  canStop,
  formatMessage,
  onOpen,
  onStop,
}: {
  member: SubagentWorkCardMember;
  now: number;
  canOpen: boolean;
  canStop: boolean;
  formatMessage: FormatMessage;
  onOpen: (member: SubagentWorkCardMember) => void;
  onStop: (workId: string) => void;
}) {
  const active = isSubagentStatusActive(member.status);
  const statusText = memberStatusText(member, now, formatMessage);
  const reasonText = member.reason
    ? formatMessage({ id: "subagentDisplay.workCard.reason" }, { reason: member.reason })
    : null;
  const rowTestId =
    canOpen && member.childSessionId
      ? testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, member.childSessionId)
      : testId(TID_V4_SUBAGENT_WORK_CARD_MEMBER, member.toolCallId);
  const stopWorkId = canStop ? member.stopWorkId : undefined;
  return (
    <li className="group/subagent-row flex min-w-0 items-center gap-1 rounded-lg transition-colors hover:bg-hover">
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
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SubagentFace
            animated={active}
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
          {member.typeLabel ? (
            <span
              data-subagent-type-label
              className="min-w-0 max-w-32 shrink-[2] truncate text-ui-xs text-foreground-subtlest"
              title={member.typeLabel}
            >
              {member.typeLabel}
            </span>
          ) : null}
          <span className="shrink-0 whitespace-nowrap text-ui-sm text-foreground-subtle tabular-nums">
            {statusText}
          </span>
        </span>
        {reasonText ? (
          // 失败 / 已停止：原因用一行灰字放在名称下方，与头像右侧文字对齐（16px 头像 + 8px 间距）。
          <span
            data-subagent-reason
            className="min-w-0 truncate pl-6 text-ui-sm text-foreground-subtle"
            title={reasonText}
          >
            {reasonText}
          </span>
        ) : null}
      </button>
      {stopWorkId && member.childSessionId ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={testId(TID_V4_SUBAGENT_WORK_CARD_STOP, member.childSessionId)}
          aria-label={formatMessage(
            { id: "subagentDisplay.workCard.stopLabel" },
            { name: member.name },
          )}
          title={formatMessage({ id: "subagentDisplay.workCard.stopLabel" }, { name: member.name })}
          onClick={(event) => {
            event.stopPropagation();
            onStop(stopWorkId);
          }}
          className="mr-1 shrink-0 text-foreground-subtle"
        >
          <SquareIcon aria-hidden className="size-3 fill-current" />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * 对话行内子智能体行（docs/desktop/multi-agent-display-spec.md「对话行内子智能体行」）：
 * 一组相邻派发 = 连续的若干行，每个子智能体一行，不再套 1.3 工作卡外框。
 * 只读父会话投影（subagent 行 + live 索引）；打开复用 `onOpenSubagentSession`（右侧唯一
 * "子智能体"Tab 并直接进入详情），停止复用 `onCancelBackgroundWork`（父会话 cancelBackgroundWork）。
 */
export function SubagentWorkRows({
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
  const stopMember = useCallback((workId: string) => cancel?.(workId), [cancel]);
  const canOpenAny = Boolean(context.sessionId && context.onOpenSubagentSession);

  return (
    <ul
      data-conversation-selectable="true"
      data-row-id={item.rowId}
      data-testid={testId(TID_V4_SUBAGENT_WORK_CARD, String(item.rowId))}
      data-state={model.active ? "running" : "ended"}
      data-member-count={model.members.length}
      className="-mx-2 flex min-w-0 flex-col gap-0.5"
    >
      {model.members.map((member) => (
        <SubagentWorkRow
          key={member.key}
          member={member}
          now={now}
          canOpen={canOpenAny && Boolean(member.childSessionId)}
          canStop={Boolean(cancel)}
          formatMessage={formatMessage}
          onOpen={openMember}
          onStop={stopMember}
        />
      ))}
    </ul>
  );
}
