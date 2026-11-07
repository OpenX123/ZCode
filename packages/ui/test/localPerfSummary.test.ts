import { describe, expect, it } from "vitest";
import { LocalTtftObserver } from "../src/v4/telemetry/localTtftObserver.js";
import type { LocalPerfSummary } from "../src/v4/telemetry/localTtftRecord.js";

// docs/desktop/engine-performance-1.1-spec.md「本地性能摘要」与 docs/trace/local-ttft-diagnostics.md。

const WORKSPACE = "C:\\Users\\someone\\secret-project";
const PROMPT = "please refactor the payment module";

function createObserver() {
  let now = 1_000;
  const summaries: LocalPerfSummary[] = [];
  const observer = new LocalTtftObserver(
    () => {},
    () => now,
    () => now,
    undefined,
    (summary) => summaries.push(summary),
  );
  observer.enabled = true;
  observer.calibrate(WORKSPACE, { instanceId: "cli", offsetMs: 0, errorMs: 1, measuredAt: 1_000 });
  return {
    observer,
    summaries,
    at(value: number) {
      now = value;
    },
  };
}

function completeMeasurement(
  harness: ReturnType<typeof createObserver>,
  base: number,
  commandId: string,
): void {
  const { observer } = harness;
  harness.at(base);
  const context = observer.start(WORKSPACE, false)!;
  harness.at(base + 8);
  observer.optimisticRendered(context);
  harness.at(base + 10);
  observer.dispatch(context, WORKSPACE, commandId, "session-1", "codex");
  harness.at(base + 40);
  observer.ack(context, "accepted");
  const facts = {
    ...context,
    instanceId: "cli",
    commandId,
    sessionId: "session-1",
    turnId: `turn-${commandId}`,
    productTurnId: `turn-${commandId}`,
    receivedAt: base + 20,
    admittedAt: base + 30,
    executionAt: base + 50,
    requestAt: base + 900,
    outputAt: base + 1_500,
    outputKind: "text" as const,
    details: [
      {
        id: "engine_prepare:1",
        stage: "engine_prepare" as const,
        start: base + 60,
        end: base + 860,
        source: "cli" as const,
        outcome: "completed" as const,
      },
    ],
  };
  harness.at(base + 1_520);
  observer.receive(
    WORKSPACE,
    {
      topic: "conversation/session-1",
      subscriptionId: "sub",
      sentAt: base + 1_510,
      fromSeq: 0,
      toSeq: base,
      ttft: facts,
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: base,
              turnId: `turn-${commandId}`,
              createdAt: base + 1_500,
              createdAtSeq: 1,
              kind: "assistantText",
              text: "here is the refactor",
              state: "streaming",
            },
          },
        ],
      },
    } as never,
    "online",
  );
}

describe("本地性能摘要", () => {
  it("每次已下发的完成观测输出一条摘要，阶段齐全且同会话第二次为 warm", () => {
    const harness = createObserver();
    completeMeasurement(harness, 10_000, "command-1");
    completeMeasurement(harness, 20_000, "command-2");

    expect(harness.summaries).toHaveLength(2);
    expect(harness.summaries[0]).toEqual({
      version: 1,
      observationId: expect.any(String),
      commandId: "command-1",
      sessionId: "session-1",
      outcome: "success",
      engine: "codex",
      start: "cold",
      sendMode: "idle",
      quality: "complete",
      clickToPreviewMs: 8,
      clickToAckMs: 40,
      clickToReceivedMs: 20,
      clickToAdmittedMs: 30,
      enginePrepareMs: 800,
      requestToFirstContentMs: 600,
      totalMs: 1_520,
    });
    expect(harness.summaries[1]).toMatchObject({ commandId: "command-2", start: "warm" });
  });

  it("下发后失败输出一条失败摘要；未下发的拒绝不输出", () => {
    const harness = createObserver();
    const { observer } = harness;
    harness.at(1_000);
    const blocked = observer.start(WORKSPACE, false)!;
    observer.exclude(blocked, "rejected");
    expect(harness.summaries).toHaveLength(0);

    harness.at(2_000);
    const failed = observer.start(WORKSPACE, false)!;
    harness.at(2_005);
    observer.dispatch(failed, WORKSPACE, "command-failed", "session-2", "zcode");
    harness.at(2_300);
    observer.exclude(failed, "failed");
    observer.exclude(failed, "failed");

    expect(harness.summaries).toEqual([
      expect.objectContaining({
        commandId: "command-failed",
        sessionId: "session-2",
        outcome: "failed",
        engine: "zcode",
        start: "cold",
        clickToAckMs: null,
        enginePrepareMs: null,
        requestToFirstContentMs: null,
        totalMs: 300,
      }),
    ]);
  });

  it("摘要不含正文与路径，非标识字符串被丢弃，未知引擎记为 unknown", () => {
    const harness = createObserver();
    const { observer } = harness;
    harness.at(1_000);
    const context = observer.start(WORKSPACE, false)!;
    observer.dispatch(context, WORKSPACE, `cmd ${PROMPT}`, "C:\\Users\\someone\\session", "weird");
    harness.at(1_100);
    observer.exclude(context, "interrupted");

    const [summary] = harness.summaries;
    expect(summary).toMatchObject({ commandId: null, sessionId: null, engine: "unknown" });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("someone");
    expect(serialized).not.toContain(PROMPT);
    for (const value of Object.values(summary!)) {
      expect(["string", "number", "boolean"].includes(typeof value) || value === null).toBe(true);
    }
  });
});
