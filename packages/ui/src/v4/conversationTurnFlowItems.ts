import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";

export type AssistantWorkRow = Exclude<ConversationRow, TurnHeaderRow | UserInputRow>;

export type ConversationTurnFlowItem =
  | { kind: "userInput"; row: UserInputRow }
  | { kind: "assistantHistory"; rows: AssistantWorkRow[] }
  | { kind: "assistantText"; row: AssistantTextRow; latest: boolean }
  | { kind: "assistantWork"; rows: AssistantWorkRow[] }
  | ConversationCuaGroupRenderItem;

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function appendGroupedAssistantFlowItem(
  items: ConversationTurnFlowItem[],
  kind: "assistantHistory" | "assistantWork",
  row: AssistantWorkRow,
): void {
  const previous = items.at(-1);
  if (previous?.kind === kind) {
    previous.rows.push(row);
    return;
  }
  items.push({ kind, rows: [row] });
}

export function buildConversationFlowItems(options: {
  orderedRows: readonly ConversationRow[];
  assistantHistoryRows: readonly AssistantWorkRow[];
  assistantFollowingRows: readonly AssistantWorkRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  /** 当前 visual work segment 外置展示的末段正文。 */
  visibleAssistantTextRow?: AssistantTextRow;
  /** 整个 product turn 唯一可挂 action 的最终正文。 */
  latestAssistantTextRow?: AssistantTextRow;
  timelineOnly: boolean;
}): ConversationTurnFlowItem[] {
  const historyRowIds = new Set(options.assistantHistoryRows.map((row) => row.rowId));
  const followingRowIds = new Set(options.assistantFollowingRows.map((row) => row.rowId));
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  const items: ConversationTurnFlowItem[] = [];

  for (const row of options.orderedRows) {
    if (isUserInputRow(row)) {
      items.push({ kind: "userInput", row });
      continue;
    }
    if (!isAssistantWorkRow(row)) continue;
    // 轮尾 boundary 已从 assistant flow 拆成 assistantTailRows；若再把它追加回
    // flowItems，renderer 会把它渲染在定时任务卡片、文件 summary 和消息操作栏之前。
    // 这里只保留真实 flow；boundary 由 TurnGroup 在全部 turn-local 附属 UI 之后统一收尾。
    if (tailRowIds.has(row.rowId)) continue;
    if (
      isAssistantTextRow(row) &&
      (row.rowId === options.visibleAssistantTextRow?.rowId || !historyRowIds.has(row.rowId)) &&
      !followingRowIds.has(row.rowId) &&
      !tailRowIds.has(row.rowId) &&
      !options.timelineOnly
    ) {
      items.push({
        kind: "assistantText",
        row,
        latest: row.rowId === options.latestAssistantTextRow?.rowId,
      });
      continue;
    }
    appendGroupedAssistantFlowItem(
      items,
      historyRowIds.has(row.rowId) && !options.timelineOnly ? "assistantHistory" : "assistantWork",
      row,
    );
  }

  return items;
}

/**
 * 段内 flow item 的 React key（spec：docs/ui/chat-virtual-scroll.md「长轮历史回填」）。
 *
 * Bug 根因（P1 长单轮回填越来越慢）：多行 item 原先一律以首行 rowId 作 key。冷快照尾窗从
 * 同一轮中部截断时，HLP01 每补一页都把更早的行并进段首 item，首行 rowId 随之变化，React
 * 把整段子树当成新节点卸载重挂；展开态下段首 item 往往装着整轮几千行工具/正文，于是每页成本
 * 随已加载行数线性增长。回路实测（1000 行单轮、展开态）：DOM 新增 68032 个节点而最终只有
 * 7355 个，段首 history 容器与其中的行在 16 页里每页都被替换。
 *
 * 修复依据：向前补页只会改变段首 assistant item 的首行，其余 item 的首行不变；向后追加
 * （流式）只改变末尾 item 的尾行，任何 item 的首行都不变。因此只给段首 assistant 多行 item
 * 一个位置 key，其余保持首行 rowId。userInput 在段首前插入也不会改变它的 key，避免 header
 * 到达的最后一页再整段重挂。
 */
export function resolveConversationFlowItemKey(
  item: ConversationTurnFlowItem,
  index: number,
  firstAssistantFlowItemIndex: number,
): string {
  if (item.kind === "userInput" || item.kind === "assistantText") {
    return `${item.kind}:${item.row.rowId}`;
  }
  if (index === firstAssistantFlowItemIndex) return `${item.kind}:leading`;
  return `${item.kind}:${item.rows[0]?.rowId ?? index}`;
}
