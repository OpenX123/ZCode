import type {
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { EditWorkspaceRewindAvailability } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ConversationDeliverable } from "@/v4/conversation-presentation/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { resolveMessageLinkOpenTarget } from "@/embeddedBrowserHelpers.js";

interface ConversationTurnRowProps {
  row: ConversationRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  hideAssistantActions?: boolean;
  deferAssistantActions?: boolean;
  assistantCopyText?: string;
  assistantPreviewCards?: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled?: boolean;
  reasoningContentVariant?: "default" | "nested";
  userInputStatus?: string;
  deliverable?: ConversationDeliverable;
  onShowSourceContext?: () => void;
}

export function ConversationTurnRow({
  row,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
  deliverable,
  onShowSourceContext,
}: ConversationTurnRowProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const content = (
    <ConversationRowView
      suppressTextFenceActions={Boolean(deliverable)}
      row={
        deliverable && row.kind === "assistantText"
          ? {
              ...row,
              text: deliverable.contextText,
              media: deliverable.media ? [deliverable.media] : undefined,
              actions: undefined,
            }
          : row
      }
      context={context}
      onFork={deliverable ? undefined : onFork}
      onRetry={deliverable ? undefined : onRetry}
      onEdit={onEdit}
      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
      hideAssistantActions={deliverable ? true : hideAssistantActions}
      deferAssistantActions={deferAssistantActions}
      assistantCopyText={assistantCopyText}
      assistantPreviewCards={deliverable ? undefined : assistantPreviewCards}
      assistantPreviewCardsAutoOpenKey={deliverable ? undefined : assistantPreviewCardsAutoOpenKey}
      assistantCodeCommentCards={deliverable ? undefined : assistantCodeCommentCards}
      assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      reasoningContentVariant={reasoningContentVariant}
      userInputStatus={userInputStatus}
    />
  );
  if (!deliverable) return content;
  return (
    <div
      data-conversation-deliverable={deliverable.key}
      data-source-row-id={deliverable.sourceRowId}
    >
      {content}
      {(
        deliverable.textFenceTargets ??
        (deliverable.sourceFormat === "textFence" ? [deliverable.target] : [])
      ).map((href) => (
        <Button
          key={href}
          data-deliverable-open-link
          type="button"
          variant="link"
          size="xs"
          title={href}
          className="mt-1 mr-3 px-0"
          disabled={!platform && !context.onOpenBrowserUrl}
          onClick={(event) => {
            // text fence 本身不可点击；直接传完整目标，避免拼 Markdown 截断括号与查询参数。
            const target = resolveMessageLinkOpenTarget({
              href,
              forceExternal: event.metaKey || event.ctrlKey,
            });
            if (target === "app-browser" || !platform) {
              context.onOpenBrowserUrl?.(href);
            } else {
              platform.openExternal(href);
            }
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
      ))}
      <Button
        data-deliverable-show-source
        variant="link"
        size="xs"
        className="mt-1 px-0 text-foreground-subtle"
        onClick={onShowSourceContext}
      >
        {intl.formatMessage({ id: "chat.deliverable.showSourceContext" })}
      </Button>
    </div>
  );
}

export function resolveAssistantCopyText(unit: ConversationTurnRenderUnit): string | undefined {
  if (!unit.latestAssistantTextRow) {
    return undefined;
  }

  const segments =
    unit.assistantTextRows.length > 0
      ? unit.assistantTextRows.map((segment) => segment.text)
      : [unit.latestAssistantTextRow.text];
  const includedSegments = new Set(segments);
  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall" || row.toolName !== "ExitPlanMode") continue;
    const markdown = extractPlanToolCallContent(toolCallRowToLegacyNode(row).toolCall, "").markdown;
    if (!markdown || includedSegments.has(markdown)) continue;
    // 产品边界：assistant 复制代表本轮完整可见回答。计划正文来自原位结构化 tool row，
    // 不能读取被 max-height/mask 裁切的卡片 DOM，也不能顺手混入普通工具输出。
    segments.push(markdown);
    includedSegments.add(markdown);
  }
  return segments.join("\n\n");
}
