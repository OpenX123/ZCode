import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { BanIcon, ChevronRightIcon, CircleCheckIcon, CircleXIcon } from "lucide-react";
import {
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_SPAWN_GROUP,
  TID_V4_SUBAGENT_SPAWN_MEMBER,
  TID_V4_SUBAGENT_SPAWN_TOGGLE,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { presetToolLayoutOpen } from "@/ToolCallBlocks/ToolLayout.js";
import {
  ConversationAgentToolCallRow,
  openSubagentSessionFromSummary,
} from "@/v4/ConversationAgentToolCallRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import type {
  AgentSpawnGroupRenderItem,
  AgentSpawnMemberItem,
  SubagentDisplayStatus,
} from "./contract.js";
import {
  buildSubagentAvatarIndex,
  formatSubagentNameListParts,
  resolveSubagentAvatarIndexes,
  subagentDisplayName,
  summarizeSubagentStatuses,
} from "./model.js";
import { describeAgentSpawnMember } from "./spawnGroups.js";
import { SubagentFace } from "./SubagentFace.js";

const EMPTY_AVATAR_INDEX = buildSubagentAvatarIndex(undefined);
const NAMES_SENTINEL = "\u0000";
// 展开态只属于 renderer 内存（与 ToolLayout 的按 toolId 记忆同一模式）：虚拟列表重挂不丢，刷新即重置。
const spawnGroupOpenState = new Map<string, boolean>();

function MemberStatusMark({ status }: { status: SubagentDisplayStatus }) {
  // 运行中不加转圈：时间线里大量旋转图标长期占用渲染，运行态由行尾计数的扫光表达。
  if (status === "done") {
    return <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />;
  }
  if (status === "failed") {
    return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "cancelled") {
    return <BanIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />;
  }
  return null;
}

/** 单个派发的 Agent 卡：沿用既有卡片，只把 Bot 图标换成该实例的头像。 */
export function ConversationAgentCard({
  item,
  context,
  avatarIndex,
  inSpawnGroup = false,
}: {
  item: Extract<AgentSpawnMemberItem, { kind: "agentToolCall" }>;
  context: ConversationRowRenderContext;
  avatarIndex?: number;
  inSpawnGroup?: boolean;
}) {
  const facts = useMemo(() => describeAgentSpawnMember(item), [item]);
  const resolvedIndex =
    avatarIndex ??
    resolveSubagentAvatarIndexes(context.subagentAvatarIndex ?? EMPTY_AVATAR_INDEX, [
      facts.childSessionId,
    ])[0];
  const icon = (
    <SubagentFace
      avatarIndex={resolvedIndex}
      name={facts.title || facts.subagentType}
      size={16}
      status={facts.status}
      subagentType={facts.subagentType}
    />
  );
  return (
    <ConversationAgentToolCallRow
      item={item}
      context={context}
      agentIcon={icon}
      inSpawnGroup={inSpawnGroup}
    />
  );
}

/**
 * 同一轮相邻派发合并后的一行："A、B 和 C 开始工作"（docs/desktop/multi-agent-display-spec.md）。
 * 名称按钮：有子会话 → 右侧只读实时对话（与 Agent 卡同一请求）；无子会话 → 展开本行与该卡的行内详情。
 * 行尾箭头展开原有的逐个 Agent 卡。
 */
export function ConversationAgentSpawnRow({
  item,
  context,
}: {
  item: AgentSpawnGroupRenderItem;
  context: ConversationRowRenderContext;
}) {
  const { intl, locale } = useZCodeIntl();
  const firstMember = describeAgentSpawnMember(item.members[0]!);
  const openStateKey = `${item.turnId}\0${firstMember.toolCallId}`;
  const [open, setOpen] = useState(() => spawnGroupOpenState.get(openStateKey) ?? false);
  // 点击无子会话成员时，重挂它的卡以读取预置的展开态（已挂载的卡不会重新读取记忆）。
  const [remountByKey, setRemountByKey] = useState<Record<string, number>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const memberElements = useRef(new Map<string, HTMLDivElement>());
  const bodyId = `spawn-group-${item.rowId}-members`;

  const members = useMemo(() => {
    const facts = item.members.map(describeAgentSpawnMember);
    const indexes = resolveSubagentAvatarIndexes(
      context.subagentAvatarIndex ?? EMPTY_AVATAR_INDEX,
      facts.map((member) => member.childSessionId),
    );
    return facts.map((member, position) => {
      const avatarIndex = indexes[position]!;
      return {
        ...member,
        avatarIndex,
        name: subagentDisplayName({
          title: member.title,
          subagentType: member.subagentType,
          fallbackName: intl.formatMessage(
            { id: "subagentDisplay.fallbackName" },
            { index: String(avatarIndex + 1) },
          ),
        }),
      };
    });
  }, [context.subagentAvatarIndex, intl, item.members]);

  const setGroupOpen = useCallback(
    (next: boolean) => {
      spawnGroupOpenState.set(openStateKey, next);
      setOpen(next);
    },
    [openStateKey],
  );

  useEffect(() => {
    if (!focusKey) return;
    const element = memberElements.current.get(focusKey);
    if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
    setFocusKey(null);
  }, [focusKey]);

  const activateMember = useCallback(
    (member: (typeof members)[number]) => {
      if (
        openSubagentSessionFromSummary({
          childSessionId: member.childSessionId,
          context,
          subagentType: member.subagentType,
          // 与 Agent 卡同一可见标题；为空时由右侧 tab 回退"子智能体"，不传类型或编号兜底。
          title: member.title,
        })
      ) {
        return;
      }
      presetToolLayoutOpen(member.toolCallId);
      setRemountByKey((current) => ({ ...current, [member.key]: (current[member.key] ?? 0) + 1 }));
      setGroupOpen(true);
      setFocusKey(member.key);
    },
    [context, setGroupOpen],
  );

  const counts = summarizeSubagentStatuses(members.map((member) => member.status));
  const countParts = (["running", "failed", "cancelled", "done"] as const)
    .filter((status) => counts[status] > 0)
    .map((status) =>
      intl.formatMessage(
        { id: `subagentDisplay.count.${status}` },
        { count: String(counts[status]) },
      ),
    );
  const sentence = intl.formatMessage(
    { id: "subagentDisplay.spawnRow.started" },
    { names: NAMES_SENTINEL },
  );
  const [prefix = "", suffix = ""] = sentence.split(NAMES_SENTINEL);
  const parts = formatSubagentNameListParts(
    members.map((member) => member.name),
    locale,
  );
  const toggleLabel = intl.formatMessage({
    id: open ? "subagentDisplay.spawnRow.collapse" : "subagentDisplay.spawnRow.expand",
  });

  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    // 名称按钮与箭头各自处理；这里只接住行内空白和文字的点击。
    if ((event.target as HTMLElement).closest("button")) return;
    setGroupOpen(!open);
  };

  return (
    <div
      className="flex flex-col"
      data-conversation-selectable="true"
      data-row-id={open ? undefined : item.rowId}
      data-testid={testId(TID_V4_SUBAGENT_SPAWN_GROUP, String(item.rowId))}
      data-spawn-count={members.length}
      data-running-count={counts.running}
      data-open={open ? "true" : "false"}
    >
      {/* 行内空白点击只是箭头按钮的快捷方式；键盘与读屏走同一行的箭头 button。 */}
      <div
        className="group/spawn flex min-h-6 w-full min-w-0 cursor-pointer items-start gap-2 text-ui-base leading-normal"
        onClick={handleRowClick}
      >
        <p className="min-w-0 flex-1 text-foreground-subtle">
          {prefix ? <span>{prefix}</span> : null}
          {parts.map((part, position) => {
            if (part.type === "literal")
              return <span key={`literal-${position}`}>{part.value}</span>;
            const member = members[part.index]!;
            const statusText = intl.formatMessage({
              id: `subagentDisplay.status.${member.status}`,
            });
            const canOpen = Boolean(
              member.childSessionId && context.sessionId && context.onOpenSubagentSession,
            );
            return (
              <button
                key={member.key}
                type="button"
                data-testid={
                  canOpen && member.childSessionId
                    ? testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, member.childSessionId)
                    : testId(TID_V4_SUBAGENT_SPAWN_MEMBER, member.toolCallId)
                }
                data-child-session-id={member.childSessionId}
                data-spawn-status={member.status}
                aria-label={intl.formatMessage(
                  {
                    id: canOpen
                      ? "subagentDisplay.spawnRow.openMember"
                      : "subagentDisplay.spawnRow.expandMember",
                  },
                  { name: member.name, status: statusText },
                )}
                title={member.name}
                onClick={() => activateMember(member)}
                className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-0.5 align-top text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <SubagentFace
                  avatarIndex={member.avatarIndex}
                  name={member.name}
                  size={16}
                  status={member.status}
                  subagentType={member.subagentType}
                />
                <span className="min-w-0 max-w-48 truncate font-medium">{member.name}</span>
                <MemberStatusMark status={member.status} />
              </button>
            );
          })}
          {suffix ? <span>{suffix}</span> : null}
        </p>
        {countParts.length > 0 ? (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-foreground-subtle",
              counts.running > 0 && "animated-gradient-text animated-gradient-text-subtle",
            )}
          >
            {countParts.join(" · ")}
          </span>
        ) : null}
        <button
          type="button"
          data-testid={testId(TID_V4_SUBAGENT_SPAWN_TOGGLE, String(item.rowId))}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setGroupOpen(!open)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtlest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 opacity-0 transition-transform transition-opacity duration-200 ease-out group-hover/spawn:opacity-100 group-focus-within/spawn:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        </button>
      </div>
      {open ? (
        <div id={bodyId} className="ml-2 mt-2 flex flex-col gap-3 border-l border-border pl-3.5">
          {item.members.map((memberItem, position) => {
            const member = members[position]!;
            const key = `${memberItem.key}:${remountByKey[memberItem.key] ?? 0}`;
            return (
              <div
                key={key}
                ref={(element) => {
                  if (element) memberElements.current.set(memberItem.key, element);
                  else memberElements.current.delete(memberItem.key);
                }}
              >
                {memberItem.kind === "agentToolCall" ? (
                  <ConversationAgentCard
                    item={memberItem}
                    context={context}
                    avatarIndex={member.avatarIndex}
                    inSpawnGroup
                  />
                ) : (
                  <ConversationTurnRow row={memberItem.row} context={context} />
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
