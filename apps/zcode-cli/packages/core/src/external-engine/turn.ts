import {
  externalEngineSessionInput,
  publishExternalEngineConfigError,
  publishExternalEngineSessionUpdate,
} from "./session.js";
import { structuredPatch } from "diff";
import { isExternalSessionEngine } from "@zcode/shared";
import {
  createMessageId,
  createPartId,
  createToolCallId,
  SessionEventType,
  type SessionEvent,
  type TraceContext,
  type MessageId,
  type TurnId,
  type TextPart,
  type ReasoningPart,
  type ToolPart,
  type ToolResultDisplayPayload,
  type ExternalEnginePermissionRequest,
  type ExternalEnginePermissionOutcome,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import type { ResolvedTurnAttachment } from "../runtime/types.js";
import { buildUserContentFromTurn } from "../runtime/helpers/conversation.js";
import type { ExternalTurnLoopState } from "./contract.js";
import type { TurnMachineImpl } from "../runtime/deps.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function selectExternalPermissionOption(
  request: ExternalEnginePermissionRequest,
  decision: "allow" | "deny" | "escalate" | "modify",
  always: boolean,
): ExternalEnginePermissionOutcome {
  // broker 无法呈现任意 ACP option；只接受语义一致的结果，绝不按索引或名称猜 id。
  const kind = decision === "allow" ? (always ? "allow_always" : "allow_once") : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}
function diffDisplay(update: Record<string, unknown>): ToolResultDisplayPayload | undefined {
  if (!Array.isArray(update.content)) return undefined;
  for (const item of update.content) {
    const content = record(item);
    if (
      content.type !== "diff" ||
      typeof content.path !== "string" ||
      typeof content.newText !== "string"
    )
      continue;
    const oldText = typeof content.oldText === "string" ? content.oldText : "";
    const patch = structuredPatch(content.path, content.path, oldText, content.newText);
    return {
      kind: "file_diff",
      filePath: content.path,
      structuredPatch: patch.hunks,
      additions: patch.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
        0,
      ),
      deletions: patch.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
        0,
      ),
    };
  }
  return undefined;
}
function outputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts = value.map(outputText).filter((text): text is string => text !== undefined);
    return texts.length ? texts.join("\n") : undefined;
  }
  const block = record(value);
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "content") return outputText(block.content);
  return undefined;
}
function toolOutput(update: Record<string, unknown>, previous: string): string | undefined {
  const meta = record(update._meta);
  const terminal = record(meta.terminal_output);
  if (typeof terminal.data === "string") return terminal.data;
  const delta = record(meta.terminal_output_delta);
  if (typeof delta.data === "string") return previous + delta.data;
  // content 可能只有终端引用、diff 或空数组；不能因此丢弃真实 rawOutput。
  if (update.rawOutput !== undefined) {
    return outputText(update.rawOutput) ?? JSON.stringify(update.rawOutput);
  }
  if (update.sessionUpdate === "tool_call" || update.rawInput !== undefined) return undefined;
  return outputText(update.content);
}
export async function runExternalEngineTurn(
  runtime: AgentRuntimeInternal,
  input: {
    input: string;
    attachments: ResolvedTurnAttachment[];
    turnId: TurnId;
    userMessageId: MessageId;
    traceContext: TraceContext;
    signal: AbortSignal;
    events: SessionEvent[];
    turnMachine: TurnMachineImpl;
  },
): Promise<ExternalTurnLoopState> {
  const engine = runtime.config.engine;
  if (!isExternalSessionEngine(engine) || !runtime.externalEnginePort)
    throw Object.assign(new Error("External engine is not ready"), { code: "engine_not_ready" });
  if (runtime.isRemoteWorkspace())
    throw new Error("External engines currently require a local workspace");
  const state: ExternalTurnLoopState = {
    events: input.events,
    modelResponse: "",
    tokenCount: 0,
    toolCallCount: 0,
    historyRoundCount: 0,
    turnMachine: input.turnMachine,
    backgroundSubagentResultConsumed: false,
    workflowResultConsumed: false,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
  };
  const messageId = createMessageId();
  const created = Date.now();
  const parts: Array<TextPart | ReasoningPart | ToolPart> = [];
  const tools = new Map<string, ToolPart>();
  let activeText: TextPart | ReasoningPart | undefined;
  const emit = async (
    type: Parameters<AgentRuntimeInternal["createEvent"]>[0],
    payload: Parameters<AgentRuntimeInternal["createEvent"]>[1],
  ) => {
    const event = runtime.createEvent(type, payload, input.traceContext);
    await runtime.appendEvent(event, input.traceContext);
    input.events.push(event);
  };
  // ACP 只给 chunk；必须补齐既有分段事件，否则工具后的正文会继续写入工具前的投影行。
  const closeActiveText = async () => {
    const part = activeText;
    if (!part) return;
    activeText = undefined;
    part.time = { start: part.time?.start ?? created, end: Date.now() };
    await runtime.persistPart(part, input.traceContext);
    await emit(SessionEventType.ModelStreaming, {
      delta: "",
      done: false,
      kind: part.type === "text" ? "text_end" : "reasoning_end",
      assistantMessageId: messageId,
      partId: part.id,
    });
  };
  await runtime.persistAssistantMessage(
    messageId,
    input.userMessageId,
    created,
    undefined,
    input.traceContext,
  );
  const prompt = buildUserContentFromTurn(input.input, input.attachments);
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  if (typeof prompt === "string") blocks.push({ type: "text", text: prompt });
  else
    for (const block of prompt) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block.type === "image" && typeof block.dataUrl === "string")
        blocks.push({
          type: "image",
          data: block.dataUrl.replace(/^data:[^,]*,/, ""),
          mimeType: block.mediaType,
        });
      else throw new Error("Attachment type is unsupported by the external engine");
    }
  try {
    const completion = runtime.externalEnginePort.runTurn({
      ...externalEngineSessionInput(runtime, input.signal, input.traceContext),
      prompt: blocks,
      async requestPermission(request) {
        const result = await runtime.permissionBroker.requestPermission(
          {
            requestId: createToolCallId(),
            sessionId: runtime.sessionId,
            turnId: input.turnId,
            traceId: input.traceContext.traceId,
            toolCallId: request.toolCall.toolCallId as ReturnType<typeof createToolCallId>,
            toolName: String(request.toolCall.title ?? request.toolCall.kind ?? "External tool"),
            input: request.toolCall.rawInput ?? {},
            mode: runtime.config.mode ?? "build",
            ruleId: "external-engine",
            reason: "外部引擎请求执行工具",
            riskLevel: "medium",
            requestedAt: new Date(),
            optionsPolicy: request.options.some((option) => option.kind === "allow_always")
              ? "session-always-allow"
              : "no-always-allow",
          },
          { signal: input.signal },
        );
        return selectExternalPermissionOption(
          request,
          result.decision,
          Boolean(result.sessionPermissionUpdates?.length || result.permissionUpdates?.length),
        );
      },
      async onUpdate(update) {
        const kind = update.sessionUpdate;
        if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
          const content = record(update.content);
          if (content.type !== "text" || typeof content.text !== "string") return;
          const parentToolCallId = record(record(update._meta).claudeCode).parentToolUseId;
          if (typeof parentToolCallId === "string") {
            const parent = tools.get(parentToolCallId);
            if (!parent || parent.state.status !== "running") return;
            const metadata = parent.state.metadata ?? {};
            const separator =
              metadata.externalActivity && metadata.externalActivityKind !== kind ? "\n\n" : "";
            const activityText = String(metadata.externalActivity ?? "") + separator + content.text;
            parent.state.metadata = {
              ...metadata,
              externalActivity: activityText,
              externalActivityKind: kind,
            };
            await runtime.persistPart(parent, input.traceContext);
            await emit(SessionEventType.ToolCallProgress, {
              toolCallId: parentToolCallId,
              activityText,
            });
            return;
          }
          const type = kind === "agent_message_chunk" ? "text" : "reasoning";
          if (!activeText || activeText.type !== type) {
            await closeActiveText();
            const nextPart: TextPart | ReasoningPart = {
              id: createPartId(),
              sessionID: runtime.sessionId,
              messageID: messageId,
              type,
              text: "",
              time: { start: Date.now() },
            };
            parts.push(nextPart);
            activeText = nextPart;
            await runtime.persistPart(nextPart, input.traceContext);
            await emit(SessionEventType.ModelStreaming, {
              delta: "",
              done: false,
              kind: type === "text" ? "text_start" : "reasoning_start",
              assistantMessageId: messageId,
              partId: nextPart.id,
            });
          }
          activeText.text += content.text;
          if (type === "text") state.modelResponse += content.text;
          await runtime.persistPart(activeText, input.traceContext);
          await emit(SessionEventType.ModelStreaming, {
            delta: content.text,
            done: false,
            kind: type === "text" ? "text_delta" : "reasoning_delta",
            assistantMessageId: messageId,
            partId: activeText.id,
          });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          await closeActiveText();
          const id = String(update.toolCallId);
          let tool = tools.get(id);
          // 工具结果之后可能还有 hook/meta 更新，不能再次发出运行态或终态。
          const settled = tool?.state.status === "completed" || tool?.state.status === "error";
          if (settled) return;
          const meta = record(record(update._meta).claudeCode);
          const parentToolCallId =
            typeof meta.parentToolUseId === "string" ? meta.parentToolUseId : undefined;
          if (!tool) {
            tool = {
              id: createPartId(),
              sessionID: runtime.sessionId,
              messageID: messageId,
              type: "tool",
              callID: id,
              declarationIndex: tools.size,
              ...(parentToolCallId ? { metadata: { parentToolCallId } } : {}),
              tool: String(
                meta.toolName ?? update.name ?? update.title ?? update.kind ?? "External tool",
              ),
              state: {
                status: "running",
                input: record(update.rawInput),
                time: { start: Date.now() },
              },
            };
            tools.set(id, tool);
            parts.push(tool);
            state.toolCallCount++;
            await emit(SessionEventType.ToolCallScheduled, {
              toolCallId: id,
              assistantMessageId: messageId,
              toolName: tool.tool,
              ...(parentToolCallId ? { parentToolCallId } : {}),
              input: tool.state.input,
              schedule: { parallelGroups: [], executionOrder: [id] },
            });
            await emit(SessionEventType.ToolCallStarted, {
              toolCallId: id,
              toolName: tool.tool,
              startedAt: new Date(),
            });
          }
          if (parentToolCallId) tool.metadata = { ...tool.metadata, parentToolCallId };
          if (typeof meta.toolName === "string" || typeof update.name === "string")
            tool.tool = String(meta.toolName ?? update.name);
          if (update.rawInput !== undefined) tool.state.input = record(update.rawInput);
          const previousMetadata = "metadata" in tool.state ? (tool.state.metadata ?? {}) : {};
          const startsAgentActivity =
            (tool.tool === "Agent" || tool.tool === "Task") &&
            previousMetadata.externalActivity === undefined;
          const display =
            diffDisplay(update) ??
            (previousMetadata.display as ToolResultDisplayPayload | undefined);
          const nextOutput = toolOutput(update, String(previousMetadata.externalOutput ?? ""));
          const output = nextOutput ?? String(previousMetadata.externalOutput ?? "");
          const metadata = {
            ...previousMetadata,
            schemaVersion: 1,
            externalOutput: output,
            ...(startsAgentActivity ? { externalActivity: "" } : {}),
            ...(display ? { display } : {}),
          };
          if (
            update.rawInput !== undefined ||
            nextOutput !== undefined ||
            parentToolCallId ||
            startsAgentActivity
          ) {
            await emit(SessionEventType.ToolCallProgress, {
              toolCallId: id,
              toolName: tool.tool,
              ...(startsAgentActivity ? { activityText: "" } : {}),
              ...(update.rawInput !== undefined ? { input: tool.state.input } : {}),
              ...(parentToolCallId ? { parentToolCallId } : {}),
              ...(nextOutput !== undefined ? { output } : {}),
            });
          }
          if (update.status === "completed" || update.status === "failed") {
            const start = "time" in tool.state ? tool.state.time.start : Date.now();
            tool.state =
              update.status === "failed"
                ? {
                    status: "error",
                    input: tool.state.input,
                    error: output || "External tool failed",
                    time: { start, end: Date.now() },
                    metadata,
                  }
                : {
                    status: "completed",
                    input: tool.state.input,
                    output,
                    title: tool.tool,
                    time: { start, end: Date.now() },
                    metadata,
                  };
            await emit(SessionEventType.ToolCallResult, {
              toolCallId: id,
              result: {
                success: update.status === "completed",
                content: output,
                ...(update.status === "failed"
                  ? {
                      error: {
                        type: "external_tool_failed",
                        message: output || "External tool failed",
                      },
                    }
                  : {}),
                ...(display ? { display } : {}),
              },
              duration: Date.now() - start,
            });
          } else if (tool.state.status === "running") tool.state.metadata = metadata;
          await runtime.persistPart(tool, input.traceContext);
        } else {
          await publishExternalEngineSessionUpdate(
            runtime,
            update,
            input.traceContext,
            input.events,
          );
        }
      },
    });
    const result = await completion.catch(async (error: unknown) => {
      // adapter 在 runTurn 抛错时清理连接，必须同步撤销 ready；否则配置会一直命中 not_ready。
      await publishExternalEngineConfigError(runtime, error, input.traceContext);
      throw error;
    });
    await closeActiveText();
    state.tokenCount = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    if (result.usage)
      await emit(SessionEventType.ModelComplete, {
        content: state.modelResponse,
        stopReason: result.stopReason,
        toolCallCount: state.toolCallCount,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: state.tokenCount,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens,
        },
      });
    if (result.stopReason === "cancelled" || input.signal.aborted)
      throw new DOMException("External engine turn cancelled", "AbortError");
    await emit(SessionEventType.AssistantMessage, { content: state.modelResponse });
    state.historyRoundCount = 1;
    return state;
  } finally {
    await closeActiveText();
    for (const part of parts) {
      if (
        part.type === "tool" &&
        (part.state.status === "running" || part.state.status === "pending")
      ) {
        const start = part.state.status === "running" ? part.state.time.start : created;
        part.state = {
          status: "error",
          input: part.state.input,
          error: input.signal.aborted
            ? "External tool cancelled"
            : "External tool did not complete",
          time: { start, end: Date.now() },
          metadata: { ...("metadata" in part.state ? part.state.metadata : {}), schemaVersion: 1 },
        };
        await emit(SessionEventType.ToolCallResult, {
          toolCallId: part.callID,
          result: { success: false, content: part.state.error },
          duration: Date.now() - start,
        });
      }
      if (part.type === "text" || part.type === "reasoning")
        part.time = { start: part.time?.start ?? created, end: Date.now() };
      await runtime.persistPart(part, input.traceContext);
    }
    await runtime.persistAssistantMessage(
      messageId,
      input.userMessageId,
      created,
      { completed: Date.now() },
      input.traceContext,
    );
  }
}
