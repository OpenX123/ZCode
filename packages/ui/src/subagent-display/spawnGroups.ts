import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { getAgentKindLabel, getAgentPrimaryText } from "@/ToolCallBlocks/renderers/agentHelpers.js";
import {
  isAgentToolCallRow,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type {
  AgentSpawnGroupRenderItem,
  AgentSpawnMemberItem,
  ConversationAssistantWorkDisplayItem,
  SubagentDisplayStatus,
} from "./contract.js";
import { isSubagentStatusActive, resolveAgentSpawnStatus } from "./model.js";

export interface AgentSpawnMemberFacts {
  key: string;
  rowId: number;
  toolCallId: string;
  /** 与 Agent 卡、右侧 tab 同一解析的可见标题；可能为空（流式输入尚未完整）。 */
  title: string;
  subagentType: string;
  childSessionId?: string;
  status: SubagentDisplayStatus;
  /** 外部引擎没有子会话时，详情在 Agent 卡内展开。 */
  inlineDetails: boolean;
  /** W8 工作卡字段，全部来自配对的 subagent 行；缺席即未知。 */
  model?: string;
  effort?: string;
  toolCallCount?: number;
  startedAt?: number;
  endedAt?: number;
  summaryText?: string;
}

export function describeAgentSpawnMember(member: AgentSpawnMemberItem): AgentSpawnMemberFacts {
  const row = agentSpawnMemberRow(member);
  const subagentRow = member.kind === "agentToolCall" ? member.subagentRow : undefined;
  const toolCall =
    member.kind === "agentToolCall" ? member.node.toolCall : toolCallRowToLegacyNode(row).toolCall;
  return {
    key: member.key,
    rowId: row.rowId,
    toolCallId: row.toolCallId,
    title: getAgentPrimaryText(toolCall, ""),
    subagentType: subagentRow?.subagentType ?? getAgentKindLabel(toolCall, ""),
    ...(subagentRow?.childSessionId ? { childSessionId: subagentRow.childSessionId } : {}),
    status: resolveAgentSpawnStatus(row, subagentRow),
    inlineDetails: row.activityText !== undefined,
    ...(subagentRow?.model ? { model: subagentRow.model } : {}),
    ...(subagentRow?.effort ? { effort: subagentRow.effort } : {}),
    ...(subagentRow?.toolCallCount !== undefined
      ? { toolCallCount: subagentRow.toolCallCount }
      : {}),
    ...(subagentRow?.startedAt !== undefined ? { startedAt: subagentRow.startedAt } : {}),
    ...(subagentRow?.endedAt !== undefined ? { endedAt: subagentRow.endedAt } : {}),
    ...(subagentRow?.summaryText ? { summaryText: subagentRow.summaryText } : {}),
  };
}

/**
 * 工作卡仍有活跃成员（运行中 / 等待 / 阻塞 / 等待启动）。与 buildSubagentWorkCardModel 的
 * `active` 同一判定：live 索引只在成员本身活跃时覆盖为 waiting/blocked，不改变活跃与否，
 * 因此只读成员行状态即可。用于完成轮次折叠豁免（multi-agent-display-spec「折叠」SAT31）。
 */
export function isActiveSubagentWorkCard(item: ConversationAssistantWorkDisplayItem): boolean {
  if (item.kind !== "agentSpawnGroup" || item.presentation !== "workCard") return false;
  return item.members.some((member) =>
    isSubagentStatusActive(describeAgentSpawnMember(member).status),
  );
}

/** 旧派发行的合并阈值：无子会话的单个派发已是一行 Agent 卡，只有相邻 ≥2 个才需要合并。 */
export const MIN_AGENT_SPAWN_GROUP_SIZE = 2;

/** 任一成员已配对带子会话的 subagent 行 → 整组渲染为工作卡（W8）。 */
function hasRegisteredChild(members: readonly AgentSpawnMemberItem[]): boolean {
  return members.some(
    (member) => member.kind === "agentToolCall" && Boolean(member.subagentRow?.childSessionId),
  );
}

export function agentSpawnMemberRow(member: AgentSpawnMemberItem): ToolCallRow {
  return member.row as ToolCallRow;
}

function asSpawnMember(item: ConversationAssistantWorkRenderItem): AgentSpawnMemberItem | null {
  if (item.kind === "agentToolCall") return item;
  if (item.kind === "row" && isAgentToolCallRow(item.row)) return item;
  return null;
}

/**
 * 把同一轮、可见工作项中相邻的派发合并（docs/desktop/multi-agent-display-spec.md
 * 「对话行内 Subagent 工作卡 · 分组」）。输入已是可见序（隐藏思考、待分类 Shell 已被剔除）；
 * 任何其它可见项都会断开相邻关系。任一成员有子会话 → 工作卡（1 个也成组）；否则 ≥2 个 → 旧派发行。
 * 组的 key 锚定首个成员的 rowId：流式追加成员不重建组件，展开状态不丢。
 */
export function groupConsecutiveAgentSpawns(
  items: readonly ConversationAssistantWorkRenderItem[],
): ConversationAssistantWorkDisplayItem[] {
  const result: ConversationAssistantWorkDisplayItem[] = [];
  let pending: AgentSpawnMemberItem[] = [];
  const flush = () => {
    const workCard = hasRegisteredChild(pending);
    if (workCard || pending.length >= MIN_AGENT_SPAWN_GROUP_SIZE) {
      const first = agentSpawnMemberRow(pending[0]!);
      const group: AgentSpawnGroupRenderItem = {
        kind: "agentSpawnGroup",
        presentation: workCard ? "workCard" : "sentence",
        key: `${workCard ? "subagentWorkCard" : "agentSpawnGroup"}:${first.rowId}`,
        rowId: first.rowId,
        turnId: first.turnId,
        members: pending,
      };
      result.push(group);
    } else {
      result.push(...pending);
    }
    pending = [];
  };
  for (const item of items) {
    const member = asSpawnMember(item);
    if (!member) {
      flush();
      result.push(item);
      continue;
    }
    const previous = pending[0];
    if (previous && agentSpawnMemberRow(previous).turnId !== agentSpawnMemberRow(member).turnId) {
      flush();
    }
    pending.push(member);
  }
  flush();
  return result;
}
