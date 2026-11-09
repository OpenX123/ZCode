// W7：轮次输出速度由 CLI 投影在轮次结束时写入 turnHeader（docs/desktop/turn-output-rate-spec.md）。
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
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const TURN = "turn-1";

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(type: SessionEventTypeUnion, payload: unknown, turnId: string | undefined = TURN) {
    this.seq += 1;
    this.events.push({
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    });
  }

  start(): void {
    this.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }, undefined);
    this.push(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "hi",
      inputId: "command-1",
      messageId: "user-1",
    });
  }

  completedCall(overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
    const merged = { inputTokens: 10, outputTokens: 120, ...usage };
    this.push(SessionEventType.ModelNetworkStatus, {
      type: "model_request_completed",
      requestId: `request-${this.seq}`,
      querySource: "main_turn",
      providerId: "provider",
      modelId: "model",
      transport: "sse",
      attempt: 1,
      maxAttempts: 3,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      durationMs: 3000,
      timeToFirstContentMs: 1000,
      reasoningContentStreamed: false,
      usage: merged,
      ...overrides,
    });
    this.push(SessionEventType.ModelComplete, {
      content: "step",
      stopReason: "end_turn",
      querySource: "main_turn",
      usage: merged,
    });
  }

  complete(resultType: "success" | "cancelled" = "success"): void {
    this.push(SessionEventType.TurnComplete, {
      response: "done",
      tokenCount: 0,
      toolCallCount: 0,
      duration: 5000,
      resultType,
    });
  }
}

function header(log: EventLog) {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of log.events) projection.applyEvent(event);
  const snapshot = projection.getSnapshot();
  conversationSnapshotSchema.parse(snapshot);
  const row = snapshot.rows.window.find((candidate) => candidate.kind === "turnHeader");
  if (row?.kind !== "turnHeader") throw new Error("missing turnHeader");
  return row;
}

describe("ProductProjection 轮次输出速度", () => {
  it("原生多次调用：轮次成功结束时写入 outputTps / generationMs / firstTokenMs", () => {
    const log = new EventLog();
    log.start();
    log.completedCall({ durationMs: 3100, timeToFirstContentMs: 1100 }, { outputTokens: 120 });
    log.completedCall(
      { durationMs: 2500, timeToFirstContentMs: 500, reasoningContentStreamed: false },
      { outputTokens: 280, reasoningTokens: 200 },
    );
    expect(header(log).outputTps).toBeUndefined();
    log.complete();

    expect(header(log)).toMatchObject({
      state: "completedSuccess",
      outputTokens: 400,
      reasoningTokens: 200,
      // 第二次调用为隐藏推理：分子 280 − 200 = 80；(120 + 80) ÷ (2s + 2s) = 50。
      outputTps: 50,
      generationMs: 4000,
      firstTokenMs: 1100,
    });
  });

  it("任一调用缺首字时间时整轮不写 tokens/s，但保留 token 累计", () => {
    const log = new EventLog();
    log.start();
    log.completedCall();
    log.completedCall({ timeToFirstContentMs: undefined });
    log.complete();
    const row = header(log);
    expect(row.outputTokens).toBe(240);
    expect(row.outputTps).toBeUndefined();
    expect(row.generationMs).toBeUndefined();
    expect(row.firstTokenMs).toBeUndefined();
  });

  it("旁路请求不计入，中断轮不写 tokens/s", () => {
    const sidecar = new EventLog();
    sidecar.start();
    sidecar.completedCall();
    sidecar.completedCall({ querySource: "session_title", timeToFirstContentMs: undefined });
    sidecar.complete();
    expect(header(sidecar).outputTps).toBe(60);

    const cancelled = new EventLog();
    cancelled.start();
    cancelled.completedCall();
    cancelled.complete("cancelled");
    expect(header(cancelled).outputTps).toBeUndefined();
  });

  it("外部引擎只有整轮 usage：累计思考 tokens，不写 tokens/s", () => {
    const log = new EventLog();
    log.start();
    log.push(SessionEventType.ModelComplete, {
      content: "reply",
      stopReason: "end_turn",
      toolCallCount: 0,
      usage: { inputTokens: 10, outputTokens: 1234, reasoningTokens: 300, totalTokens: 1244 },
    });
    log.complete();
    const row = header(log);
    expect(row).toMatchObject({ outputTokens: 1234, reasoningTokens: 300 });
    expect(row.outputTps).toBeUndefined();
    expect(row.firstTokenMs).toBeUndefined();
  });
});
