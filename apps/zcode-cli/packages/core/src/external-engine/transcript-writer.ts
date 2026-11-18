import { structuredPatch } from "diff";
import { assistantMediaRefSchema, type AssistantMediaRef } from "@zcode/shared/zcode-protocol-v4";
import {
  createMessageId,
  createPartId,
  SessionEventType,
  type MessageId,
  type FilePart,
  type ReasoningPart,
  type SessionEvent,
  type TextPart,
  type ToolPart,
  type ToolResultDisplayPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";

const EXTERNAL_TURN_CANCELLED_MESSAGE = "External engine turn cancelled";
const OUTPUT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const OUTPUT_MEDIA_MAX_BASE64_CHARS = Math.ceil(OUTPUT_MEDIA_MAX_BYTES / 3) * 4;

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
  readonly parts: Array<TextPart | ReasoningPart | ToolPart | FilePart> = [];
  response = "";
  toolCallCount = 0;
  private readonly detachedTools = new Set<string>();

  /** 最后一个正文 part 的文本（含仍在流式写入的段）；子智能体摘要以此为准。 */
  get lastText(): string | undefined {
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index];
      if (part?.type === "text") return part.text;
    }
    return undefined;
  }
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

  /**
   * 只通知实时 sinks、不落库的事件（与内置子智能体镜像同一语义，见 subagent.ts 的
   * notifyEventSinks 镜像）：用于把子会话活动摘要告诉宿主会话，冷恢复不重放。
   */
  async notifyLive(
    type: Parameters<AgentRuntimeInternal["createEvent"]>[0],
    payload: Parameters<AgentRuntimeInternal["createEvent"]>[1],
  ): Promise<void> {
    const event = this.runtime.createEvent(type, payload, this.traceContext);
    await this.runtime.notifyEventSinks(event, this.traceContext);
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
    const parentToolCallId = record(record(update._meta).claudeCode).parentToolUseId;
    if (content.type !== "text" || typeof content.text !== "string") {
      // 父工具活动的 owner 仍是工具元数据，不能因媒体分支抢先处理而污染主回答。
      if (typeof parentToolCallId === "string" || kind === "agent_thought_chunk") {
        const resource = content.type === "resource" ? record(content.resource) : content;
        const mime =
          typeof resource.mimeType === "string" ? resource.mimeType.slice(0, 128) : "unknown";
        let reference = "";
        try {
          const uri = new URL(String(resource.uri ?? ""));
          if (["https:", "http:"].includes(uri.protocol) && !uri.username && !uri.password)
            reference = uri.href.slice(0, 4096);
        } catch {
          /* 无可安全打开的引用，仅保留类型提示。 */
        }
        await this.chunk(
          {
            ...update,
            content: {
              type: "text",
              text: `\n[ACP resource: ${mime}]${reference ? ` ${reference}` : ""}\n`,
            },
          },
          kind,
        );
        return;
      }
      await this.mediaChunk(content, kind);
      return;
    }
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

  private async mediaChunk(
    content: Record<string, unknown>,
    kind: "agent_message_chunk" | "agent_thought_chunk",
  ): Promise<void> {
    const resource = content.type === "resource" ? record(content.resource) : content;
    const mime = typeof resource.mimeType === "string" ? resource.mimeType.toLowerCase() : "";
    const uri = typeof resource.uri === "string" ? resource.uri : "";
    const mediaType = mime.split("/", 1)[0];
    const id = createPartId();
    const name =
      typeof content.name === "string" && content.name.trim()
        ? content.name.slice(0, 512)
        : undefined;
    const candidate = (source: AssistantMediaRef["source"]) =>
      assistantMediaRefSchema.safeParse({
        id,
        mediaType,
        mimeType: mime,
        source,
        ...(name ? { name } : {}),
      });
    const data =
      typeof resource.blob === "string"
        ? resource.blob
        : typeof resource.data === "string"
          ? resource.data
          : undefined;
    let media: AssistantMediaRef | undefined;
    let sizeBytes: number | undefined;
    // 旧 writer 在非 text 分支直接 return，ACP 图片/音频永久丢失。先沿附件 data URL 格式落 artifact 与 FilePart，
    // 然后沿同一 ModelStreaming 文本段发布引用，杜绝内联本体进入 topic 或冷恢复漂移。
    if (
      data !== undefined &&
      candidate({ kind: "artifact", uri: "zcode-artifact://validation/media" }).success
    ) {
      if (
        data.length <= OUTPUT_MEDIA_MAX_BASE64_CHARS &&
        // 分组重复正则在合法20 MiB输入上耗尽V8栈；长度与字母表分别验证保持同一编码边界。
        data.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/u.test(data) &&
        data.length > 0
      ) {
        const bytes = Buffer.from(data, "base64");
        if (bytes.byteLength <= OUTPUT_MEDIA_MAX_BYTES) {
          const store = this.runtime.artifactStore;
          if (!store) throw new Error("ACP media artifact storage unavailable");
          const artifact = await store.writeToolResultArtifact({
            sessionId: this.runtime.sessionId,
            toolCallId: id,
            toolName: "external-engine-media",
            content: `data:${mime};base64,${data}`,
            contentType: "text/plain",
            retention: "session",
            trace: this.traceContext,
          });
          media = candidate({ kind: "artifact", uri: artifact.uri }).data;
          if (!media) throw new Error("ACP media artifact reference invalid");
          sizeBytes = bytes.byteLength;
        }
      }
    } else if (data === undefined && uri) {
      media = candidate({
        kind: uri.startsWith("zcode-artifact://") ? "artifact" : "url",
        ...(uri.startsWith("zcode-artifact://") ? { uri } : { url: uri }),
      } as AssistantMediaRef["source"]).data;
    }
    if (!media) {
      // 未知类型保留有界可读提示及原引用，绝不序列化 content（可能带 base64/凭据）。
      let reference = "";
      try {
        const parsed = new URL(uri);
        if (
          ["https:", "http:", "file:"].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password
        )
          reference = uri.slice(0, 4096);
      } catch {
        /* 非 URL 引用不提升为可打开资源。 */
      }
      const receivedText = typeof resource.text === "string" ? resource.text.slice(0, 4000) : "";
      await this.chunk(
        {
          content: {
            type: "text",
            text: `\n[ACP resource unavailable: ${mime.slice(0, 128) || "unknown"}]${reference ? ` ${reference}` : ""}${receivedText ? `\n${receivedText}` : ""}\n`,
          },
        },
        kind,
      );
      return;
    }
    await this.closeActiveText();
    const source = media.source.kind === "artifact" ? media.source.uri : media.source.url;
    const part: FilePart = {
      id,
      sessionID: this.runtime.sessionId,
      messageID: this.messageId,
      type: "file",
      mime,
      url: source,
      ...(name ? { filename: name } : {}),
      metadata: {
        storageKind: media.source.kind === "artifact" ? "artifact" : "remote_ref",
        ...(media.source.kind === "artifact" ? { artifactUri: source } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        assistantMedia: media,
      },
    };
    this.parts.push(part);
    await this.runtime.persistPart(part, this.traceContext);
    await this.emit(SessionEventType.ModelStreaming, {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId: this.messageId,
      partId: id,
    });
    await this.emit(SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta: "",
      done: false,
      assistantMessageId: this.messageId,
      partId: id,
      media: [media],
    });
    await this.emit(SessionEventType.ModelStreaming, {
      kind: "text_end",
      delta: "",
      done: false,
      assistantMessageId: this.messageId,
      partId: id,
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
        tool: String(
          meta.toolName ?? update.name ?? update.title ?? update.kind ?? "External tool",
        ),
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
        ...(!result.success ? { error: { type: "external_tool_failed", message: error } } : {}),
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

  /**
   * 跨轮仍在运行的原生子智能体：其 Agent 行不参与本轮 finish 的“未完成”清扫，保持 running，
   * 之后由同一 writer 的 settleSyntheticTool 收尾（part 按 id 更新，不依赖 message 未结束）。
   */
  detachSyntheticTool(callID: string): void {
    if (this.tools.get(callID)?.state.status === "running") this.detachedTools.add(callID);
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

  /** 原生 reply 也必须成为 child 正文，不能只停留在父工具摘要中。 */
  async settleFinalReply(reply: string): Promise<void> {
    if (!reply.trim()) return;
    const finalPart = this.parts.at(-1);
    // 当前归一 reply 没有原生正文身份：只对最后完整 text 逐字去重，部分包含不能吞掉不同结果。
    if (finalPart?.type === "text" && finalPart.text === reply) return;
    await this.closeActiveText();
    await this.chunk({ content: { type: "text", text: reply } }, "agent_message_chunk");
  }

  /** 收尾：关闭分段、未结束工具记失败，并持久化 assistant message 终态。 */
  async finish(options: {
    aborted: boolean;
    error?: { name: string; data: Record<string, unknown> };
  }): Promise<void> {
    await this.closeActiveText();
    for (const part of this.parts) {
      if (
        part.type === "tool" &&
        !this.detachedTools.has(part.callID) &&
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
      {
        completed: Date.now(),
        // aborted 先前只关闭工具，assistant 未保存取消事实，冷详情会被误还原为成功。
        ...(options.error
          ? { error: options.error }
          : options.aborted
            ? {
                error: {
                  name: "AbortError",
                  data: { message: EXTERNAL_TURN_CANCELLED_MESSAGE, resultType: "cancelled" },
                },
              }
            : {}),
      },
      this.traceContext,
    );
  }
}
