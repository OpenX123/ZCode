import { expect, test, vi } from "vitest";
import {
  createSessionId,
  SessionEventType,
  type ExternalEnginePort,
  type MessagePart,
  type MessageInfo,
  type SessionEvent,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { externalSubagentSessionId } from "../src/external-engine/subagents.js";
import { ExternalTranscriptWriter } from "../src/external-engine/transcript-writer.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

// UX03：reply 是最终正文，response 仍累积全部 text；只对最后一段完整正文逐字去重。
test.each<{
  name: string;
  chunks: string[];
  reply: string;
  expected: string[];
  toolAfter?: boolean;
}>([
  { name: "reply-only", chunks: [], reply: "最终结果", expected: ["最终结果"] },
  {
    name: "完整正文由多个 chunk 组成",
    chunks: ["最终", "结果"],
    reply: "最终结果",
    expected: ["最终结果"],
  },
  {
    name: "不同 reply",
    chunks: ["过程说明"],
    reply: "最终结果",
    expected: ["过程说明", "最终结果"],
  },
  {
    name: "reply 仅为正文子串",
    chunks: ["完整最终结果"],
    reply: "最终结果",
    expected: ["完整最终结果", "最终结果"],
  },
  {
    name: "正文仅为 reply 子串",
    chunks: ["结果"],
    reply: "最终结果",
    expected: ["结果", "最终结果"],
  },
  { name: "空白 reply", chunks: ["已有正文"], reply: " \n ", expected: ["已有正文"] },
  { name: "空 reply 无正文", chunks: [], reply: "", expected: [] },
  {
    name: "首尾空白仍是不同正文",
    chunks: ["最终结果"],
    reply: " 最终结果 ",
    expected: ["最终结果", " 最终结果 "],
  },
  {
    name: "工具前过程不能替代最终正文",
    chunks: ["最终结果"],
    toolAfter: true,
    reply: "最终结果",
    expected: ["最终结果", "最终结果"],
  },
])(
  "原生子会话最终结果：$name，持久化、response 与父摘要一致",
  async ({ chunks, reply, expected, toolAfter }) => {
    const sessionId = createSessionId();
    const childId = externalSubagentSessionId(sessionId, "final-child");
    const sessionStore = createRecordingSubagentSessionStore();
    const partSnapshots: MessagePart[] = [];
    const messageSnapshots: MessageInfo[] = [];
    const savePart = sessionStore.savePart.bind(sessionStore);
    const saveMessage = sessionStore.saveMessage.bind(sessionStore);
    const savedParts = vi.spyOn(sessionStore, "savePart").mockImplementation(async (part) => {
      // 记录实际写入时的值；writer 后续会原地更新 part，不能用可变引用伪证落库顺序。
      partSnapshots.push(structuredClone(part));
      await savePart(part);
    });
    const savedMessages = vi
      .spyOn(sessionStore, "saveMessage")
      .mockImplementation(async (message) => {
        messageSnapshots.push(structuredClone(message));
        await saveMessage(message);
      });
    const finished = vi.spyOn(ExternalTranscriptWriter.prototype, "finish");
    const events: SessionEvent[] = [];
    const port: ExternalEnginePort = {
      async prepareSession() {},
      async runTurn(input) {
        await input.onSession("native-root");
        await input.onSubagent!({
          type: "spawned",
          nativeSessionId: "final-child",
          name: "核对最终结果",
          cancellable: false,
        });
        for (const text of chunks)
          await input.onChildUpdate!("final-child", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        if (toolAfter)
          await input.onChildUpdate!("final-child", {
            sessionUpdate: "tool_call",
            toolCallId: "process-tool",
            name: "Read",
            rawInput: { path: "README.md" },
            status: "completed",
            rawOutput: "已检查",
          });
        await input.onSubagent!({ type: "reply", nativeSessionId: "final-child", text: reply });
        await input.onSubagent!({
          type: "state",
          nativeSessionId: "final-child",
          state: "completed",
        });
        // 重复终态及迟到帧不能再改 child 正文和父摘要。
        await input.onSubagent!({
          type: "state",
          nativeSessionId: "final-child",
          state: "completed",
        });
        await input.onSubagent!({
          type: "reply",
          nativeSessionId: "final-child",
          text: "迟到结果",
        });
        await input.onChildUpdate!("final-child", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "迟到正文" },
        });
        return { stopReason: "end_turn" };
      },
      setConfigOption: vi.fn(),
      closeSession: vi.fn(),
    };
    const runtime = new AgentRuntime(
      sessionId,
      { engine: "claude-code", workingDirectory: "/workspace" },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore,
        externalEnginePort: port,
        modelFactory: () => {
          throw new Error("Provider must not run");
        },
        eventSink: { onSessionEvent: async (event) => void events.push(event) },
      },
    );
    try {
      await runtime.executeTurn("派发");
      const childWriter = finished.mock.contexts[0]!;
      expect(childWriter.response).toBe(expected.join(""));
      const messages = await sessionStore.messages({ sessionID: childId });
      const assistant = messages.filter((message) => message.info.role === "assistant");
      const parts = [
        ...new Map(
          assistant.flatMap((message) => message.parts).map((part) => [part.id, part]),
        ).values(),
      ];
      expect(parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual(expected);
      const completed = events.filter(
        (event) => event.sessionId === childId && event.type === SessionEventType.TurnComplete,
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        response: expected.join(""),
        resultType: "success",
      });
      const summary = reply.trim() ? reply : expected.join("");
      const stopped = events.filter((event) => event.type === SessionEventType.SubagentStopped);
      expect(stopped).toHaveLength(1);
      if (summary) expect(stopped[0]?.payload).toMatchObject({ summaryText: summary });
      else expect(stopped[0]?.payload).not.toHaveProperty("summaryText");
      const parentParts = [
        ...new Map(
          (await sessionStore.messages({ sessionID: sessionId }))
            .flatMap((message) => message.parts)
            .map((part) => [part.id, part]),
        ).values(),
      ];
      const agent = parentParts.find((part) => part.type === "tool" && part.tool === "Agent");
      expect(agent).toMatchObject({ state: { status: "completed" } });
      if (agent?.type !== "tool" || agent.state.status !== "completed")
        throw new Error("缺少父 Agent 结果");
      expect(JSON.parse(agent.state.output)).toEqual(
        expect.objectContaining({ ...(summary ? { result: summary } : {}), status: "completed" }),
      );
      const finalPart = parts.at(-1);
      if (finalPart) {
        const partWrite = partSnapshots.findIndex(
          (part) =>
            part.id === finalPart.id && part.type === "text" && part.text === expected.at(-1),
        );
        const completedWrite = messageSnapshots.findIndex(
          (message) =>
            message.sessionID === childId &&
            message.role === "assistant" &&
            message.time.completed !== undefined,
        );
        expect(partWrite).toBeGreaterThanOrEqual(0);
        expect(completedWrite).toBeGreaterThanOrEqual(0);
        expect(savedParts.mock.invocationCallOrder[partWrite]).toBeLessThan(
          savedMessages.mock.invocationCallOrder[completedWrite]!,
        );
      }
    } finally {
      finished.mockRestore();
      await runtime.closeBrowserSession();
    }
  },
);

// 停止入口只对原生声明可取消的运行中子会话生效（docs/desktop/external-agent-engines-spec.md「停止」）。
test("原生子会话 Stop：可取消的转为 cancelSubagent，不可取消的拒绝且不发原生请求", async () => {
  const sessionId = createSessionId();
  const events: SessionEvent[] = [];
  let runtime!: AgentRuntime;
  const results: unknown[] = [];
  const cancelSubagent = vi.fn(async () => {});
  const port: ExternalEnginePort = {
    async prepareSession() {},
    async runTurn(input) {
      await input.onSession("native-root");
      await input.onSubagent!({
        type: "spawned",
        nativeSessionId: "child-stoppable",
        name: "Stoppable",
        task: "可停止",
        cancellable: true,
      });
      await input.onSubagent!({
        type: "spawned",
        nativeSessionId: "child-fixed",
        name: "Fixed",
        task: "不可停止",
        cancellable: false,
      });
      results.push(
        await runtime.cancelBackgroundTask(externalSubagentSessionId(sessionId, "child-fixed")),
        await runtime.cancelBackgroundTask(externalSubagentSessionId(sessionId, "child-stoppable")),
      );
      await input.onSubagent!({
        type: "state",
        nativeSessionId: "child-stoppable",
        state: "cancelled",
      });
      await input.onSubagent!({
        type: "state",
        nativeSessionId: "child-fixed",
        state: "completed",
      });
      return { stopReason: "end_turn" };
    },
    setConfigOption: vi.fn(),
    closeSession: vi.fn(),
    cancelSubagent,
  };
  runtime = new AgentRuntime(
    sessionId,
    { engine: "claude-code", workingDirectory: "/workspace" },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: () => {
        throw new Error("Provider must not run");
      },
      externalEnginePort: port,
      eventSink: { onSessionEvent: async (event) => void events.push(event) },
    },
  );
  await runtime.executeTurn("派发");

  expect(results).toEqual([
    expect.objectContaining({ cancelled: false, reason: "background_task_not_cancellable" }),
    expect.objectContaining({ cancelled: true }),
  ]);
  expect(cancelSubagent).toHaveBeenCalledTimes(1);
  expect(cancelSubagent).toHaveBeenCalledWith(sessionId, "child-stoppable");
  // 只有可取消子会话发布可停止的后台工作。
  const started = events.filter((event) => event.type === SessionEventType.BackgroundTaskStarted);
  expect(
    started.map((event) => (event.payload as { childSessionId: string }).childSessionId),
  ).toEqual([externalSubagentSessionId(sessionId, "child-stoppable")]);
  // 同一父会话、同一原生 ID 的派生 ID 稳定；不同父会话不冲突。
  expect(externalSubagentSessionId(sessionId, "child-fixed")).toBe(
    externalSubagentSessionId(sessionId, "child-fixed"),
  );
  expect(externalSubagentSessionId(createSessionId(), "child-fixed")).not.toBe(
    externalSubagentSessionId(sessionId, "child-fixed"),
  );
});

// W8 工作卡步骤数（docs/desktop/multi-agent-display-spec.md「引擎无关合同」第 6 条）：
// 子会话每写一条工具行，父会话实时收到一次 source=subagent 的镜像 scheduled（不落库），
// 结束时 SubagentStopped 带 totalToolUseCount；外部引擎不知道子模型时不发 model/effort。
test("原生子会话工具行计步：实时镜像到父会话、不落库，结束时写入 totalToolUseCount", async () => {
  const sessionId = createSessionId();
  const events: SessionEvent[] = [];
  const eventStore = createTestSessionEventStore();
  const port: ExternalEnginePort = {
    async prepareSession() {},
    async runTurn(input) {
      await input.onSession("native-root");
      await input.onSubagent!({
        type: "spawned",
        nativeSessionId: "child-steps",
        name: "Explorer",
        task: "核对契约",
        cancellable: false,
      });
      const tool = (toolCallId: string) =>
        input.onChildUpdate!("child-steps", {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Read",
          rawInput: { path: "README.md" },
          status: "pending",
        });
      await tool("child-tool-1");
      // 同一工具调用的后续更新不再计步。
      await input.onChildUpdate!("child-steps", {
        sessionUpdate: "tool_call_update",
        toolCallId: "child-tool-1",
        status: "completed",
        rawOutput: "ok",
      });
      await tool("child-tool-2");
      await input.onSubagent!({
        type: "state",
        nativeSessionId: "child-steps",
        state: "completed",
      });
      return { stopReason: "end_turn" };
    },
    setConfigOption: vi.fn(),
    closeSession: vi.fn(),
  };
  const runtime = new AgentRuntime(
    sessionId,
    { engine: "codex", workingDirectory: "/workspace" },
    {
      eventStore,
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: () => {
        throw new Error("Provider must not run");
      },
      externalEnginePort: port,
      eventSink: { onSessionEvent: async (event) => void events.push(event) },
    },
  );
  await runtime.executeTurn("派发");

  const childSessionId = externalSubagentSessionId(sessionId, "child-steps");
  const mirrored = events.filter(
    (event) =>
      event.sessionId === sessionId &&
      event.type === SessionEventType.ToolCallScheduled &&
      (event.payload as { source?: string }).source === "subagent",
  );
  expect(mirrored.map((event) => event.payload)).toEqual([
    expect.objectContaining({
      agentId: "child-steps",
      childSessionId,
      childToolCallId: "child-tool-1",
      source: "subagent",
    }),
    expect.objectContaining({ agentId: "child-steps", childToolCallId: "child-tool-2" }),
  ]);
  const persisted = await eventStore.getEvents(sessionId);
  expect(
    persisted.filter((event) => (event.payload as { source?: string }).source === "subagent"),
  ).toEqual([]);
  const spawned = persisted.find((event) => event.type === SessionEventType.SubagentSpawned);
  expect(spawned?.payload).not.toHaveProperty("model");
  expect(spawned?.payload).not.toHaveProperty("effort");
  const stopped = persisted.find((event) => event.type === SessionEventType.SubagentStopped);
  expect(stopped?.payload).toMatchObject({ childSessionId, totalToolUseCount: 2 });
});
