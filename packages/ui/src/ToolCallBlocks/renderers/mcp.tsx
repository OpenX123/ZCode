import {
  resolveConversationDisclosureKeys,
  readLegacyMcpToolPresentation,
  type McpToolPresentation,
} from "@/v4/conversation-presentation/index.js";
import {
  getConversationDisclosureOverride,
  useConversationDisclosureScope,
  useConversationDisclosureVersion,
} from "@/v4/conversation-presentation/disclosure.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { ChevronRightIcon, PlugIcon } from "lucide-react";
import { useCallback, useId, useMemo } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ToolCallProgressIndicator,
  readToolCallProgress,
} from "@/ToolCallBlocks/ToolCallProgressIndicator.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const MCP_TOOL_ICON = <PlugIcon className="size-4 shrink-0 text-foreground-subtle" />;
const COMPACT_RESULT_MAX_LENGTH = 160;
const COLLAPSIBLE_CODE_LAYOUT_STYLE = {
  containIntrinsicSize: "none",
  contentVisibility: "visible",
} as const;

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isCompactResult(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= COMPACT_RESULT_MAX_LENGTH &&
    !trimmed.includes("\n") &&
    !looksLikeJson(trimmed)
  );
}

function stringifyMcpResult(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isMcpToolPresentation(value: unknown): value is McpToolPresentation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "mcp_tool" &&
    typeof record.serverName === "string" &&
    record.serverName.trim().length > 0 &&
    typeof record.toolName === "string" &&
    record.toolName.trim().length > 0
  );
}

export function readMcpToolPresentation(
  context: Pick<ToolCallBlockRenderContext, "toolCallNode">,
): McpToolPresentation | null {
  const raw = context.toolCallNode.toolCall.raw;
  if (typeof raw === "object" && raw !== null) {
    const display = (raw as Record<string, unknown>).display;
    if (isMcpToolPresentation(display)) return display;
  }
  return readLegacyMcpToolPresentation(context.toolCallNode.toolCall.toolName);
}

export function formatMcpIdentifier(value: string): string {
  const words = value.trim().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  if (!words) return value;
  return words[0]!.toLocaleUpperCase() + words.slice(1);
}

export function formatMcpServerLabel(value: string): string {
  const namespaceSegments = value
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  // 插件 MCP 的 configured server key 带有 plugin:<plugin>:<server> 命名空间，
  // 直接作为 UI 文案会暴露内部路由标识。末段才是用户配置的 server 名称。
  const displayIdentifier =
    namespaceSegments[0]?.toLocaleLowerCase() === "plugin" && namespaceSegments.length > 1
      ? namespaceSegments.at(-1)!
      : value;
  return formatMcpIdentifier(displayIdentifier);
}

export function formatMcpToolLabel(toolName: string, serverLabel: string): string {
  const formattedToolName = formatMcpIdentifier(toolName);
  const repeatedPrefix = `${serverLabel} `;
  // 不少 MCP 工具会再次用 server 名作为 tool 前缀；summary 同时展示 server
  // 来源文字时会出现 Firebase / Firebase get environment。只做大小写无关的机械去重。
  return formattedToolName.toLocaleLowerCase().startsWith(repeatedPrefix.toLocaleLowerCase())
    ? formatMcpIdentifier(formattedToolName.slice(repeatedPrefix.length))
    : formattedToolName;
}

export function McpToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const scope = useConversationDisclosureScope();
  const raw = context.toolCallNode.toolCall.raw as Record<string, unknown> | undefined;
  const disclosure =
    scope && typeof raw?.turnId === "string"
      ? {
          keys: resolveConversationDisclosureKeys(scope, raw.turnId, "mcpTool", [
            context.toolCallNode.toolCall.toolId,
          ]),
          defaultOpen: context.isRunning,
        }
      : undefined;
  const presentation = readMcpToolPresentation(context);
  const { toolCall } = context.toolCallNode;
  const serverLabel = presentation?.serverName
    ? formatMcpServerLabel(presentation.serverName)
    : undefined;
  const toolLabel = presentation
    ? formatMcpToolLabel(presentation.toolName, serverLabel ?? "")
    : toolCall.title;
  const callDetailsLabel = intl.formatMessage({ id: "chat.toolCall.mcp.callDetails" });
  const resultLabel = intl.formatMessage({ id: "chat.toolCall.mcp.result" });
  const copyResultLabel = intl.formatMessage({ id: "chat.toolCall.mcp.copyResult" });
  const wrapLinesLabel = intl.formatMessage({ id: "chat.toolCall.mcp.wrapLines" });
  const descriptionLabel = intl.formatMessage({ id: "chat.toolCall.mcp.description" });
  const parametersLabel = intl.formatMessage({ id: "chat.toolCall.mcp.parameters" });
  const hasCallDetails = Boolean(presentation?.description || toolCall.input !== undefined);
  const resultText = stringifyMcpResult(toolCall.output);
  const visibleError =
    toolCall.status === "failed" || context.errorText
      ? (toolCall.error ?? context.errorText)
      : undefined;
  const hasPrimaryResult = Boolean(resultText || visibleError);
  const isSummaryOnlyLifecycle = toolCall.status === "pending" || toolCall.status === "stopped";
  // R7：运行中且 agent 投影了 MCP 进度时，摘要行显示细进度条 + message；终态由投影清除。
  const progress = toolCall.status === "in_progress" ? readToolCallProgress(toolCall.raw) : null;
  const stoppedSummaryStatus =
    toolCall.status === "stopped" ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-subtlest">·</span>
        <span>{context.statusLabel}</span>
      </span>
    ) : progress ? (
      <ToolCallProgressIndicator progress={progress} />
    ) : undefined;
  const failedSummaryStatus =
    toolCall.status === "failed" ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-subtlest">·</span>
        <span>{context.statusLabel}</span>
      </span>
    ) : undefined;
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      // MCP 详情之前先展示 description 和参数，用户展开后仍像 API 调试器。
      // 参考 BUA，把结果作为一级内容；调用元数据收进透明的二级折叠区。
      <div className="mb-2 space-y-3 py-1" data-testid="mcp-expanded-content">
        {visibleError ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium text-destructive">{resultLabel}</h4>
            <p
              className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
              data-testid="mcp-error-surface"
            >
              {visibleError}
            </p>
          </section>
        ) : resultText && isCompactResult(resultText) ? (
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="mcp-result-surface"
          >
            {resultText.trim()}
          </p>
        ) : resultText ? (
          <div
            className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
            data-testid="mcp-result-surface"
          >
            <CodeBlock
              appTheme={context.theme}
              className="bg-card"
              code={resultText}
              enableSyntaxHighlighting={looksLikeJson(resultText)}
              language={looksLikeJson(resultText) ? "json" : "log"}
              renderMermaid={false}
              style={COLLAPSIBLE_CODE_LAYOUT_STYLE}
              wrapLongLines
            >
              <CodeBlockHeader className="pl-3 pr-2 pt-2">
                <CodeBlockTitle>
                  <span className="text-ui-base font-medium text-foreground-subtle">
                    {resultLabel}
                  </span>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockWrapButton aria-label={wrapLinesLabel} title={wrapLinesLabel} />
                  <CodeBlockCopyButton aria-label={copyResultLabel} title={copyResultLabel} />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        ) : toolCall.status === "pending" ? (
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="mcp-pending-surface"
          >
            {context.statusLabel}
          </p>
        ) : (
          // 无 result 的 pending/running/stopped MCP 展开后 ToolCallBody 为空，
          // 用户无法判断当前阶段。这里沿用 summary 的国际化状态，不另造生命周期文案。
          <p className="text-ui-base text-foreground-subtle">{context.statusLabel}</p>
        )}
        {hasCallDetails ? (
          <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-foreground-subtlest hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
              >
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" />
                {callDetailsLabel}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-2">
                {presentation?.description ? (
                  <section className="space-y-1.5">
                    <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                      {descriptionLabel}
                    </h4>
                    <p className="whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
                      {presentation.description}
                    </p>
                  </section>
                ) : null}
                {toolCall.input !== undefined ? (
                  <section className="space-y-1.5">
                    <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                      {parametersLabel}
                    </h4>
                    <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                      <CodeBlock
                        appTheme={context.theme}
                        code={JSON.stringify(toolCall.input, null, 2)}
                        language="json"
                      />
                    </div>
                  </section>
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </div>
    ),
    [
      callDetailsLabel,
      copyResultLabel,
      context,
      descriptionLabel,
      handleLoadFullToolCallFields,
      hasCallDetails,
      hasPrimaryResult,
      parametersLabel,
      presentation?.description,
      resultLabel,
      resultText,
      toolCall,
      visibleError,
      wrapLinesLabel,
    ],
  );

  if (!presentation) return null;

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      disclosure={disclosure}
      collapsedSummary={
        visibleError ? (
          <p
            className="mt-1 line-clamp-2 break-words text-ui-sm text-destructive"
            data-testid="mcp-error-summary"
          >
            {visibleError}
          </p>
        ) : undefined
      }
      icon={MCP_TOOL_ICON}
      showIcon={context.showIcon !== false}
      // Pending / stopped 没有可消费结果，展开只会重复状态或暴露诊断参数。
      // 即使父层请求 forceOpen，也必须遵守这两个生命周期的 summary-only 语义。
      canToggle={!isSummaryOnlyLifecycle && (context.canToggle ?? true)}
      forceOpen={!isSummaryOnlyLifecycle && (context.forceOpen ?? false)}
      kindLabel="MCP"
      kindDetail={
        serverLabel ? <span className="text-foreground-subtle">{serverLabel}</span> : undefined
      }
      primaryText={toolLabel}
      summaryContentSeparator="·"
      // Pending/Running/Completed 都是正常生命周期，不在摘要重复状态；Stopped 是异常终态，
      // 用显式分隔节点避免非动画摘要的两个文本节点粘连。Failed 使用专用错误状态槽位。
      secondaryText={stoppedSummaryStatus}
      statusLabel={failedSummaryStatus}
      statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={presentation.description ?? presentation.toolName}
      renderContent={renderContent}
    />
  );
}

/** 仅是展示父节点；真实子调用和权限身份仍由 childToolList 保留。 */
export function McpGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const scope = useConversationDisclosureScope();
  const localKey = useId();
  useConversationDisclosureVersion();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const raw = toolCall.raw as { turnId: string; mcpServerName: string; mcpGroupIds: string[] };
  const groupKeys = scope
    ? resolveConversationDisclosureKeys(scope, raw.turnId, "mcpGroup", raw.mcpGroupIds)
    : [`mcpGroup:local:${localKey}`];
  const childKeys = scope
    ? resolveConversationDisclosureKeys(scope, raw.turnId, "mcpTool", raw.mcpGroupIds)
    : [];
  const failures = childToolCalls.flatMap((child) => {
    const error = getToolCallErrorText(child.toolCall);
    return error || child.toolCall.status === "failed"
      ? [
          {
            id: child.toolCall.toolId,
            error: error ?? intl.formatMessage({ id: "chat.toolCall.status.failed" }),
          },
        ]
      : [];
  });
  // 运行中耗时按子工具 id 命中（docs/chat/turn-stall-indicator.md「工具行耗时」）。
  const activityToolCallIds = useMemo(
    () => childToolCalls.map((child) => child.toolCall.toolId),
    [childToolCalls],
  );
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      activityToolCallIds={activityToolCallIds}
      icon={MCP_TOOL_ICON}
      kindLabel={formatMcpServerLabel(raw.mcpServerName)}
      primaryText={intl.formatMessage(
        // 当前翻译器只支持 {key} 插值，不能把 ICU plural 模板直接显示给用户。
        { id: childToolCalls.length === 1 ? "chat.toolCall.mcp.call" : "chat.toolCall.mcp.calls" },
        { count: childToolCalls.length },
      )}
      statusLabel={context.statusLabel}
      showStatusLabel
      isRunning={context.isRunning}
      disclosure={{
        keys: groupKeys,
        defaultOpen:
          context.isRunning ||
          childKeys.some((key) => getConversationDisclosureOverride([key]) === true),
      }}
      collapsedSummary={
        failures.length ? (
          <div
            data-testid="mcp-group-error-summary"
            className="mt-1 space-y-1 text-ui-sm text-destructive"
          >
            {failures.map((failure) => (
              <p key={failure.id} className="line-clamp-2 break-words">
                {failure.error}
              </p>
            ))}
          </div>
        ) : undefined
      }
      renderContent={() => <div data-testid="mcp-group-content">{context.childToolList}</div>}
    />
  );
}
