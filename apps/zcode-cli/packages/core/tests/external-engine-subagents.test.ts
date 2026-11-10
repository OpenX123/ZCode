import { expect, test, vi } from "vitest";
import {
  createSessionId,
  SessionEventType,
  type ExternalEnginePort,
  type SessionEvent,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { externalSubagentSessionId } from "../src/external-engine/subagents.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

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
      await input.onSubagent!({ type: "state", nativeSessionId: "child-stoppable", state: "cancelled" });
      await input.onSubagent!({ type: "state", nativeSessionId: "child-fixed", state: "completed" });
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
  expect(started.map((event) => (event.payload as { childSessionId: string }).childSessionId)).toEqual(
    [externalSubagentSessionId(sessionId, "child-stoppable")],
  );
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
      await input.onSubagent!({ type: "state", nativeSessionId: "child-steps", state: "completed" });
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
