// 轮次活动（docs/chat/turn-stall-indicator.md）：ProductProjection 是 turnActivity 唯一所有者。
import { describe, expect, it } from "vitest";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const T0 = 1_700_000_000_000;

class EventLog {
  private seq = 0;

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { timestampMs: number; turnId?: string },
  ): SessionEvent {
    this.seq += 1;
    return {
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(opts.timestampMs),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
  }
}

function activityPatches(deltas: readonly ConversationDelta[]) {
  return deltas.flatMap((delta) =>
    delta.op === "state.updated" && "turnActivity" in delta.patch ? [delta.patch.turnActivity] : [],
  );
}

function startTurn(projection: ProductProjection, log: EventLog, turnId = "turn-1") {
  projection.applyEvent(
    log.push(
      SessionEventType.SessionCreated,
      { mode: "default", contextWindow: 200_000 },
      { timestampMs: T0 - 1000 },
    ),
  );
  return projection.applyEvent(
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "hello" },
      { turnId, timestampMs: T0 },
    ),
  );
}

describe("ProductProjection turnActivity", () => {
  it("TurnStarted 后进入 waiting_model，并记录事件时间", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    const deltas = startTurn(projection, log);

    expect(activityPatches(deltas)).toEqual([
      {
        turnId: "turn-1",
        lastActivityAt: T0,
        phaseStartedAt: T0,
        activityPhase: { kind: "waiting_model" },
      },
    ]);
    expect(projection.getSnapshot().turnActivity?.activityPhase).toEqual({ kind: "waiting_model" });
  });

  it("5s 内的连续流式事件不重复发布，超过间隔后刷新 lastActivityAt", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    startTurn(projection, log);
    const stream = (timestampMs: number, kind: string, delta = "") =>
      projection.applyEvent(
        log.push(
          SessionEventType.ModelStreaming,
          { kind, delta, done: false },
          { turnId: "turn-1", timestampMs },
        ),
      );

    expect(activityPatches(stream(T0 + 1000, "text_start"))).toEqual([]);
    expect(activityPatches(stream(T0 + 3000, "text_delta", "a"))).toEqual([]);
    const refreshed = activityPatches(stream(T0 + 6000, "text_delta", "b"));
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ lastActivityAt: T0 + 6000, phaseStartedAt: T0 });
  });

  it("工具 running 时为 running_tool，结束后回到 waiting_model；patch 不递增 revision", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    startTurn(projection, log);
    projection.applyEvent(
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-1",
          toolName: "Bash",
          input: { command: "sleep 600" },
          schedule: { parallelGroups: [["tool-1"]], executionOrder: ["tool-1"] },
        },
        { turnId: "turn-1", timestampMs: T0 + 500 },
      ),
    );
    projection.applyEvent(
      log.push(
        SessionEventType.ToolCallStarted,
        { toolCallId: "tool-1", toolName: "Bash", startedAt: new Date(T0 + 1000) },
        { turnId: "turn-1", timestampMs: T0 + 1000 },
      ),
    );
    expect(projection.getSnapshot().turnActivity).toEqual({
      turnId: "turn-1",
      lastActivityAt: T0 + 1000,
      phaseStartedAt: T0 + 1000,
      activityPhase: { kind: "running_tool", toolName: "Bash", toolCallId: "tool-1" },
    });

    const revisionBefore = projection.getSnapshot().revision;
    // 运行中的工具进度不改变阶段，只在间隔后刷新时间。
    const progress = projection.applyEvent(
      log.push(
        SessionEventType.ToolCallProgress,
        { toolCallId: "tool-1", activityText: "still running" },
        { turnId: "turn-1", timestampMs: T0 + 20_000 },
      ),
    );
    const progressPatches = activityPatches(progress);
    expect(progressPatches.at(-1)).toMatchObject({
      lastActivityAt: T0 + 20_000,
      phaseStartedAt: T0 + 1000,
    });
    if (progress.every((delta) => delta.op === "state.updated" && "turnActivity" in delta.patch)) {
      expect(projection.getSnapshot().revision).toBe(revisionBefore);
    }

    projection.applyEvent(
      log.push(
        SessionEventType.ToolCallResult,
        { toolCallId: "tool-1", result: { success: true, content: "ok" }, duration: 900 },
        { turnId: "turn-1", timestampMs: T0 + 21_000 },
      ),
    );
    expect(projection.getSnapshot().turnActivity).toMatchObject({
      lastActivityAt: T0 + 21_000,
      phaseStartedAt: T0 + 21_000,
      activityPhase: { kind: "waiting_model" },
    });
  });

  it("轮次结束后清空 turnActivity", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    startTurn(projection, log);
    const deltas = projection.applyEvent(
      log.push(
        SessionEventType.TurnComplete,
        { response: "", tokenCount: 0, toolCallCount: 0, duration: 10, resultType: "success" },
        { turnId: "turn-1", timestampMs: T0 + 2000 },
      ),
    );
    expect(activityPatches(deltas)).toEqual([null]);
    expect(projection.getSnapshot().turnActivity).toBeNull();
  });

  it("其它轮次的迟到事件不刷新当前轮次活动", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    startTurn(projection, log, "turn-2");
    const stale = projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "late", done: false },
        { turnId: "turn-1", timestampMs: T0 + 60_000 },
      ),
    );
    expect(activityPatches(stale)).toEqual([]);
    expect(projection.getSnapshot().turnActivity?.lastActivityAt).toBe(T0);
  });
});
