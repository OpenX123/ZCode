import { useCallback, useMemo, type ReactNode } from "react";
import { TID_V4_ROW, TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared/test-ids";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { getAgentPrimaryText } from "@/ToolCallBlocks/renderers/agentHelpers.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

export function openSubagentSessionFromSummary({
  backgrounded: _backgrounded = false,
  childSessionId,
  context,
  subagentType,
  title,
}: {
  backgrounded?: boolean;
  childSessionId?: string;
  context: ConversationRowRenderContext;
  subagentType: string;
  title: string;
}): boolean {
  const parentSessionId = context.sessionId;
  const onOpenSubagentSession = context.onOpenSubagentSession;
  if (!childSessionId || !parentSessionId || !onOpenSubagentSession) {
    return false;
  }

  onOpenSubagentSession({
    rootSessionId: context.rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId,
    subagentType,
    title,
  });
  return true;
}

export function ConversationAgentToolCallRow({
  item,
  context,
  agentIcon,
  inSpawnGroup = false,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "agentToolCall" }>;
  context: ConversationRowRenderContext;
  /** 宿主画好的子智能体头像（实例序号 + 类型）；缺席时沿用 Bot 图标。 */
  agentIcon?: ReactNode;
  /**
   * 位于合并派发行内：直开入口的 test id 归派发行的名称按钮，这里不再重复，
   * 保证每个 child 在 DOM 中只有一个 `v4-subagent-open-side-pane-*` 入口。
   */
  inSpawnGroup?: boolean;
}) {
  const toolCallNode = item.node;
  const childSessionId = item.subagentRow?.childSessionId;
  const subagentType = item.subagentRow?.subagentType ?? "subagent";
  // 与 Agent 摘要行复用同一 title resolver，保证右侧 tab 和用户点击的可见标题逐字一致。
  const title = getAgentPrimaryText(toolCallNode.toolCall, "");
  const canOpenChildSession = Boolean(
    childSessionId && context.sessionId && context.onOpenSubagentSession,
  );
  const handleOpenChildSession = useCallback(() => {
    openSubagentSessionFromSummary({ childSessionId, context, subagentType, title });
  }, [childSessionId, context, subagentType, title]);
  const agentSummaryAction = useMemo(
    () =>
      canOpenChildSession && childSessionId
        ? {
            onActivate: handleOpenChildSession,
            ...(inSpawnGroup
              ? {}
              : { testId: testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId) }),
          }
        : undefined,
    [canOpenChildSession, childSessionId, handleOpenChildSession, inSpawnGroup],
  );

  // Agent 工具行和普通工具行同属工作流，不能在配对壳上额外加 px-4，
  // 否则会和未配对 toolCall 行产生左右缩进差异。
  return (
    <div
      data-row-id={item.row.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.row.rowId))}
    >
      <ToolCallBlock
        toolCallNode={toolCallNode}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        agentSummaryAction={agentSummaryAction}
        authoritativeAgentType={item.subagentRow?.subagentType}
        agentIcon={agentIcon}
      />
    </div>
  );
}
