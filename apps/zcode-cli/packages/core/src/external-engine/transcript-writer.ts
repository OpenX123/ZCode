import { structuredPatch } from "diff";
import {
  createMessageId,
  createPartId,
  SessionEventType,
  type MessageId,
  type ReasoningPart,
  type SessionEvent,
  type TextPart,
  type ToolPart,
  type ToolResultDisplayPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

/** 合成工具行（原生子智能体的父会话 Agent 行）的终态。 */
export interface SyntheticToolSettlement {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

/**
 * 一条外部引擎 assistant message 的唯一写入者：ACP 正文/思考/工具 → message/part 持久化 +
 * 既有 ModelStreaming / ToolCall* 事件。父轮与原生子会话（写入子 Runtime）共用，保证两处
 * 持久化形状一致（docs/desktop/external-agent-engines-spec.md「外部引擎原生子智能体」）。
 */
export class ExternalTranscriptWriter {
  readonly messageId: MessageId = createMessageId();
  readonly parts: Array<TextPart | ReasoningPart | ToolPart> = [];
  response = "";
  toolCallCount = 0;
  private readonly created = Date.now();
  private readonly tools = new Map<string, ToolPart>();
  private activeText: TextPart | ReasoningPart | undefined;

  constructor(
    private readonly runtime: AgentRuntimeInternal,
    private readonly userMessageId: MessageId,
    private readonly traceContext: TraceContext,
    private readonly events?: SessionEvent[],
  ) {}

  async begin(): Promise<void> {
    await this.runtime.persistAssistantMessage(
      this.messageId,
      this.userMessageId,
      this.created,
      undefined,
      this.traceContext,
    );
  }

  async emit(
    type: Parameters<AgentRuntimeInternal["createEvent"]>[0],
    payload: Parameters<AgentRuntimeInternal["createEvent"]>[1],
  ): Promise<void> {
    const event = this.runtime.createEvent(type, payload, this.traceContext);
    await this.runtime.appendEvent(event, this.traceContext);
    this.events?.push(event);
  }

  /** ACP 只给 chunk；必须补齐既有分段事件，否则工具后的正文会继续写入工具前的投影行。 */
  async closeActiveText(): Promise<void> {
    const part = this.activeText;
    if (!part) return;
    this.activeText = undefined;
    part.time = { start: part.time?.start ?? this.created, end: Date.now() };
    await this.runtime.persistPart(part, this.traceContext);
    await this.emit(SessionEventType.ModelStreaming, {
      delta: "",
      done: false,
      kind: part.type === "text" ? "text_end" : "reasoning_end",
      assistantMessageId: this.messageId,
      partId: part.id,
    });
  }

  /** 处理正文/思考/工具更新；其它种类返回 false 交调用方处理。 */
  async apply(update: Record<string, unknown>): Promise<boolean> {
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      await this.chunk(update, kind);
      return true;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      await this.tool(update);
      return true;
    }
    return false;
  }

  private async chunk(
    update: Record<string, unknown>,
    kind: "agent_message_chunk" | "agent_thought_chunk",
  ): Promise<void> {
    const content = record(update.content);
    if (content.type !== "text" || typeof content.text !== "string") return;
    const parentToolCallId = record(record(update._meta).claudeCode).parentToolUseId;
    if (typeof parentToolCallId === "string") {
      const parent = this.tools.get(parentToolCallId);
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
      await this.runtime.persistPart(parent, this.traceContext);
      await this.emit(SessionEventType.ToolCallProgress, {
        toolCallId: parentToolCallId,
        activityText,
      });
      return;
    }
    const type = kind === "agent_message_chunk" ? "text" : "reasoning";
    if (!this.activeText || this.activeText.type !== type) {
      await this.closeActiveText();
      const nextPart: TextPart | ReasoningPart = {
        id: createPartId(),
        sessionID: this.runtime.sessionId,
        messageID: this.messageId,
        type,
        text: "",
        time: { start: Date.now() },
      };
      this.parts.push(nextPart);
      this.activeText = nextPart;
      await this.runtime.persistPart(nextPart, this.traceContext);
      await this.emit(SessionEventType.ModelStreaming, {
        delta: "",
        done: false,
        kind: type === "text" ? "text_start" : "reasoning_start",
        assistantMessageId: this.messageId,
        partId: nextPart.id,
      });
    }
    const active = this.activeText;
    active.text += content.text;
    if (type === "text") this.response += content.text;
    await this.runtime.persistPart(active, this.traceContext);
    await this.emit(SessionEventType.ModelStreaming, {
      delta: content.text,
      done: false,
      kind: type === "text" ? "text_delta" : "reasoning_delta",
      assistantMessageId: this.messageId,
      partId: active.id,
    });
  }

  private async schedule(tool: ToolPart, parentToolCallId?: string): Promise<void> {
    this.tools.set(tool.callID, tool);
    this.parts.push(tool);
    this.toolCallCount++;
    await this.emit(SessionEventType.ToolCallScheduled, {
      toolCallId: tool.callID,
      assistantMessageId: this.messageId,
      toolName: tool.tool,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      input: tool.state.input,
      schedule: { parallelGroups: [], executionOrder: [tool.callID] },
    });
    await this.emit(SessionEventType.ToolCallStarted, {
      toolCallId: tool.callID,
      toolName: tool.tool,
      startedAt: new Date(),
    });
  }

  private async tool(update: Record<string, unknown>): Promise<void> {
    await this.closeActiveText();
    const id = String(update.toolCallId);
    let tool = this.tools.get(id);
    // 工具结果之后可能还有 hook/meta 更新，不能再次发出运行态或终态。
    const settled = tool?.state.status === "completed" || tool?.state.status === "error";
    if (settled) return;
    const meta = record(record(update._meta).claudeCode);
    const parentToolCallId =
      typeof meta.parentToolUseId === "string" ? meta.parentToolUseId : undefined;
    if (!tool) {
      tool = {
        id: createPartId(),
        sessionID: this.runtime.sessionId,
        messageID: this.messageId,
        type: "tool",
        callID: id,
        declarationIndex: this.tools.size,
        ...(parentToolCallId ? { metadata: { parentToolCallId } } : {}),
        tool: String(meta.toolName ?? update.name ?? update.title ?? update.kind ?? "External tool"),
        state: { status: "running", input: record(update.rawInput), time: { start: Date.now() } },
      };
      await this.schedule(tool, parentToolCallId);
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
      diffDisplay(update) ?? (previousMetadata.display as ToolResultDisplayPayload | undefined);
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
      await this.emit(SessionEventType.ToolCallProgress, {
        toolCallId: id,
        toolName: tool.tool,
        ...(startsAgentActivity ? { activityText: "" } : {}),
        ...(update.rawInput !== undefined ? { input: tool.state.input } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(nextOutput !== undefined ? { output } : {}),
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      await this.settle(tool, {
        success: update.status === "completed",
        output,
        ...(update.status === "failed" ? { error: output || "External tool failed" } : {}),
        metadata,
        display,
      });
    } else if (tool.state.status === "running") tool.state.metadata = metadata;
    await this.runtime.persistPart(tool, this.traceContext);
  }

  private async settle(
    tool: ToolPart,
    result: SyntheticToolSettlement & { display?: ToolResultDisplayPayload; error?: string },
  ): Promise<void> {
    const error = result.error ?? result.output;
    const start = "time" in tool.state ? tool.state.time.start : Date.now();
    const metadata = result.metadata ?? ("metadata" in tool.state ? tool.state.metadata : {}) ?? {};
    tool.state = result.success
      ? {
          status: "completed",
          input: tool.state.input,
          output: result.output,
          title: tool.tool,
          time: { start, end: Date.now() },
          metadata,
        }
      : {
          status: "error",
          input: tool.state.input,
          error,
          time: { start, end: Date.now() },
          metadata,
        };
    await this.emit(SessionEventType.ToolCallResult, {
      toolCallId: tool.callID,
      result: {
        success: result.success,
        content: result.output,
        ...(!result.success
          ? { error: { type: "external_tool_failed", message: error } }
          : {}),
        ...(result.display ? { display: result.display } : {}),
      },
      duration: Date.now() - start,
    });
  }

  /** 合成一条运行中的工具行（不来自 ACP tool_call）；callID 已存在时保持幂等。 */
  async startSyntheticTool(input: {
    callID: string;
    tool: string;
    input: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    if (this.tools.has(input.callID)) return;
    await this.closeActiveText();
    const tool: ToolPart = {
      id: createPartId(),
      sessionID: this.runtime.sessionId,
      messageID: this.messageId,
      type: "tool",
      callID: input.callID as ToolPart["callID"],
      declarationIndex: this.tools.size,
      metadata: input.metadata,
      tool: input.tool,
      state: {
        status: "running",
        input: input.input,
        time: { start: Date.now() },
        metadata: { schemaVersion: 1, ...input.metadata },
      },
    };
    await this.schedule(tool);
    await this.runtime.persistPart(tool, this.traceContext);
  }

  async settleSyntheticTool(callID: string, result: SyntheticToolSettlement): Promise<void> {
    const tool = this.tools.get(callID);
    if (!tool || tool.state.status !== "running") return;
    await this.settle(tool, {
      ...result,
      metadata: { schemaVersion: 1, ...tool.metadata, ...result.metadata },
    });
    await this.runtime.persistPart(tool, this.traceContext);
  }

  /** 收尾：关闭分段、未结束工具记失败，并持久化 assistant message 终态。 */
  async finish(options: { aborted: boolean; error?: { name: string; data: Record<string, unknown> } }): Promise<void> {
    await this.closeActiveText();
    for (const part of this.parts) {
      if (
        part.type === "tool" &&
        (part.state.status === "running" || part.state.status === "pending")
      ) {
        const start = part.state.status === "running" ? part.state.time.start : this.created;
        part.state = {
          status: "error",
          input: part.state.input,
          error: options.aborted ? "External tool cancelled" : "External tool did not complete",
          time: { start, end: Date.now() },
          metadata: { ...("metadata" in part.state ? part.state.metadata : {}), schemaVersion: 1 },
        };
        await this.emit(SessionEventType.ToolCallResult, {
          toolCallId: part.callID,
          result: { success: false, content: part.state.error },
          duration: Date.now() - start,
        });
      }
      if (part.type === "text" || part.type === "reasoning")
        part.time = { start: part.time?.start ?? this.created, end: Date.now() };
      await this.runtime.persistPart(part, this.traceContext);
    }
    await this.runtime.persistAssistantMessage(
      this.messageId,
      this.userMessageId,
      this.created,
      { completed: Date.now(), ...(options.error ? { error: options.error } : {}) },
      this.traceContext,
    );
  }
}
