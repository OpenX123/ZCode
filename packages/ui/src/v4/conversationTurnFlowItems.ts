import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";
import {
  extractConversationDeliverables,
  type ConversationDeliverable,
} from "@/v4/conversation-presentation/index.js";

export type AssistantWorkRow = Exclude<ConversationRow, TurnHeaderRow | UserInputRow>;

export type ConversationTurnFlowItem =
  | { kind: "userInput"; row: UserInputRow }
  | { kind: "assistantHistory"; rows: AssistantWorkRow[] }
  | {
      kind: "assistantText";
      row: AssistantTextRow;
      latest: boolean;
      deliverable?: ConversationDeliverable;
    }
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
  const visibleTargets = new Set(
    extractConversationDeliverables(
      [options.visibleAssistantTextRow, options.latestAssistantTextRow].filter(
        (row): row is AssistantTextRow => row !== undefined,
      ),
    ).map((reference) => reference.target),
  );
  const sourceRows = options.orderedRows.filter(
    (row): row is AssistantTextRow =>
      isAssistantTextRow(row) && (historyRowIds.has(row.rowId) || followingRowIds.has(row.rowId)),
  );
  const sourceById = new Map(sourceRows.map((row) => [row.rowId, row]));
  const referencesByRow = new Map<number, ConversationDeliverable[]>();
  for (const reference of options.timelineOnly ? [] : extractConversationDeliverables(sourceRows)) {
    const references = referencesByRow.get(reference.sourceRowId) ?? [];
    references.push(reference);
    referencesByRow.set(reference.sourceRowId, references);
  }
  type SourceContext = {
    reference: ConversationDeliverable;
    targets: Set<string>;
    textFenceTargets: Set<string>;
  };
  const contexts: SourceContext[] = [];
  for (const references of referencesByRow.values()) {
    let context: SourceContext | undefined;
    for (const reference of references.toSorted(
      (a, b) => a.contextStart - b.contextStart || a.start - b.start,
    )) {
      if (!context || reference.contextStart >= context.reference.contextEnd) {
        context = { reference, targets: new Set(), textFenceTargets: new Set() };
        contexts.push(context);
      } else {
        // 独立入口会借前段说明；合并相交区间，避免 A 段单列后又在 B 的上下文里重复。
        const contextStart = context.reference.contextStart;
        const contextEnd = Math.max(context.reference.contextEnd, reference.contextEnd);
        const anchor = context.reference.start <= reference.start ? context.reference : reference;
        context.reference = {
          ...anchor,
          contextStart,
          contextEnd,
          contextText: sourceById.get(reference.sourceRowId)!.text.slice(contextStart, contextEnd),
        };
      }
      context.targets.add(reference.target);
      if (reference.sourceFormat === "textFence") context.textFenceTargets.add(reference.target);
    }
  }
  // 先合并来源区间再判最终覆盖，首引用锚点不因部分覆盖而跳到另一目标。
  const deliverables = contexts
    .filter((context) => [...context.targets].some((target) => !visibleTargets.has(target)))
    .map((context) => ({
      ...context.reference,
      textFenceTargets: [...context.textFenceTargets].filter(
        (target) => !visibleTargets.has(target),
      ),
    }));
  let appendedDeliverables = false;
  const appendDeliverables = () => {
    if (appendedDeliverables) return;
    appendedDeliverables = true;
    for (const deliverable of deliverables) {
      const row = sourceById.get(deliverable.sourceRowId);
      if (row) items.push({ kind: "assistantText", row, latest: false, deliverable });
    }
  };

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
      // 原历史原位保留；仅在外置正文之前投影完整来源段，不能因“已工作”收起而丢失成果。
      appendDeliverables();
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
  appendDeliverables();

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
  if (item.kind === "assistantText" && item.deliverable)
    return `deliverable:${item.deliverable.key}`;
  if (item.kind === "userInput" || item.kind === "assistantText") {
    return `${item.kind}:${item.row.rowId}`;
  }
  if (index === firstAssistantFlowItemIndex) return `${item.kind}:leading`;
  return `${item.kind}:${item.rows[0]?.rowId ?? index}`;
}
