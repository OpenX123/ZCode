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
