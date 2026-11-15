import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type MessagePart,
  type SessionEvent,
  type TraceContext,
  type ToolArtifactWriteRequest,
} from "@zcode/contracts";
import { ExternalTranscriptWriter } from "../src/external-engine/transcript-writer.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

function setup(failStorage = false) {
  const order: string[] = [];
  const parts = new Map<string, MessagePart>();
  const events: SessionEvent[] = [];
  const write = vi.fn(async (_request: ToolArtifactWriteRequest) => {
    order.push("artifact");
    if (failStorage) throw new Error("fixture storage unavailable");
    return { uri: "zcode-artifact://s1/media1", bytes: 3, contentType: "image/png" };
  });
  const runtime = {
    sessionId: "s1",
    workingDirectory: "/workspace",
    artifactStore: { writeToolResultArtifact: write },
    persistAssistantMessage: vi.fn(),
    persistPart: vi.fn(async (part: MessagePart) => {
      order.push(`part:${part.type}`);
      parts.set(part.id, structuredClone(part));
    }),
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    appendEvent: async (event: SessionEvent) => {
      order.push("event");
      events.push(event);
    },
  } as unknown as AgentRuntimeInternal;
  return {
    writer: new ExternalTranscriptWriter(runtime, "u1" as never, {} as TraceContext),
    runtime,
    write,
    parts,
    events,
    order,
  };
}

describe("ACP v1 媒体持久化", () => {
  it("20 MiB 上限内合法base64不会耗尽正则栈，metadata仍为decoded大小", async () => {
    const { writer, write, parts } = setup();
    const bytes = 20 * 1024 * 1024;
    await writer.apply({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        mimeType: "image/png",
        data: Buffer.alloc(bytes).toString("base64"),
      },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect([...parts.values()]).toContainEqual(
      expect.objectContaining({
        type: "file",
        metadata: expect.objectContaining({ sizeBytes: bytes }),
      }),
    );
  });
  it("媒体到达后取消保持持久引用与既有取消metadata", async () => {
    const { writer, runtime, events, parts } = setup();
    await writer.apply({
      sessionUpdate: "agent_message_chunk",
      content: { type: "audio", mimeType: "audio/wav", data: "YWJj" },
    });
    await writer.finish({ aborted: true });
    expect([...parts.values()].filter((p) => p.type === "file")).toHaveLength(1);
    expect(
      events.filter(
        (e) =>
          e.type === SessionEventType.ModelStreaming && (e.payload as { media?: unknown }).media,
      ),
    ).toHaveLength(1);
    expect(runtime.persistAssistantMessage).toHaveBeenLastCalledWith(
      writer.messageId,
      "u1",
      expect.any(Number),
      expect.objectContaining({
        error: {
          name: "AbortError",
          data: { message: "External engine turn cancelled", resultType: "cancelled" },
        },
      }),
      {},
    );
  });
  it("思考中的非文本块保留reasoning提示，不产生主回答媒体", async () => {
    const { writer, write, parts } = setup();
    await writer.apply({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "image", mimeType: "image/png", data: "YWJj" },
    });
    expect(write).not.toHaveBeenCalled();
    expect([...parts.values()]).toContainEqual(
      expect.objectContaining({ type: "reasoning", text: expect.stringContaining("image/png") }),
    );
    expect(writer.response).toBe("");
  });
  it("父工具活动的非文本块不提升为主回答媒体", async () => {
    const { writer, parts, events, write } = setup();
    await writer.apply({
      sessionUpdate: "tool_call",
      toolCallId: "agent-1",
      name: "Agent",
      status: "in_progress",
    });
    await writer.apply({
      sessionUpdate: "agent_message_chunk",
      _meta: { claudeCode: { parentToolUseId: "agent-1" } },
      content: { type: "image", data: "YWJj", mimeType: "image/png" },
    });
    expect(write).not.toHaveBeenCalled();
    expect([...parts.values()].some((p) => p.type === "file")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === SessionEventType.ToolCallProgress &&
          JSON.stringify(e.payload).includes("image/png"),
      ),
    ).toBe(true);
    expect(writer.response).toBe("");
  });
  it.each([
    { type: "image", data: "YWJj", mimeType: "image/png", uri: "https://example.com/image" },
    { type: "audio", data: "YWJj", mimeType: "audio/wav" },
    {
      type: "resource",
      resource: { uri: "file:///workspace/clip", blob: "YWJj", mimeType: "video/mp4" },
    },
  ])("真实 ContentBlock 脱敏 fixture 先存 artifact/FilePart 再发既有流 %j", async (content) => {
    const { writer, write, parts, events, order } = setup();
    await writer.begin();
    await writer.apply({ sessionUpdate: "agent_message_chunk", content });
    await writer.finish({ aborted: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringMatching(/^data:(image|audio|video)\/[a-z0-9]+;base64,YWJj$/u),
      contentType: "text/plain",
      retention: "session",
    });
    const file = [...parts.values()].find((p) => p.type === "file");
    expect(file).toMatchObject({
      type: "file",
      url: "zcode-artifact://s1/media1",
      metadata: {
        storageKind: "artifact",
        sizeBytes: 3,
        assistantMedia: {
          id: file?.id,
          source: { kind: "artifact", uri: "zcode-artifact://s1/media1" },
        },
      },
    });
    const stream = events.filter((e) => e.type === SessionEventType.ModelStreaming);
    expect(stream.map((e) => (e.payload as { kind: string }).kind)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
    ]);
    expect(stream.some((e) => (e.payload as { media?: unknown[] }).media?.length === 1)).toBe(true);
    expect(order.indexOf("artifact")).toBeLessThan(order.indexOf("part:file"));
    expect(order.indexOf("part:file")).toBeLessThan(order.indexOf("event"));
    expect(JSON.stringify(events)).not.toContain("YWJj");
    expect(JSON.stringify([...parts.values()])).not.toContain("YWJj");
  });
  it("resource_link 无扩展名由 MIME 识别，未知资源保留提示和原引用", async () => {
    const { writer, parts, events, write } = setup();
    await writer.apply({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "https://example.com/download",
        name: "audio",
        mimeType: "audio/mpeg",
      },
    });
    await writer.apply({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource",
        resource: {
          uri: "https://example.com/report",
          mimeType: "application/x-example",
          text: "收到的说明",
        },
      },
    });
    await writer.finish({ aborted: false });
    expect(write).not.toHaveBeenCalled();
    expect([...parts.values()]).toContainEqual(
      expect.objectContaining({ type: "file", mime: "audio/mpeg" }),
    );
    expect(writer.response).toContain("https://example.com/report");
    expect(writer.response).toContain("收到的说明");
    expect(JSON.stringify(events)).not.toContain("data:");
  });
  it("存储失败不发布媒体成功事实", async () => {
    const { writer, events } = setup(true);
    await expect(
      writer.apply({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "YWJj", mimeType: "image/png" },
      }),
    ).rejects.toThrow("fixture storage unavailable");
    expect(events).toHaveLength(0);
  });
  it.each(["%invalid%", "x".repeat(28_000_000)])(
    "非法或超限 base64 不写 artifact 且有可读结果",
    async (data) => {
      const { writer, write } = setup();
      await writer.apply({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data, mimeType: "image/png" },
      });
      expect(write).not.toHaveBeenCalled();
      expect(writer.response.length).toBeGreaterThan(0);
      expect(writer.response.length).toBeLessThan(1000);
    },
  );
});
