// W8 Subagent 工作卡：父会话投影在 subagent 行与 running[] 上提供 model / effort / toolCallCount
// （docs/desktop/multi-agent-display-spec.md「引擎无关合同」第 6 条）。
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
import { conversationSnapshotSchema, type SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { turnId?: string } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

const TURN = "turn-1";
const PARENT_CALL = "call_parent_agent";

function startParentAgent(log: EventLog, spawn: Record<string, unknown> = {}): void {
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
  log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "delegate" }, { turnId: TURN });
  log.push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId: PARENT_CALL,
      toolName: "Agent",
      input: { description: "核对排班报错请求契约", subagent_type: "explorer" },
      schedule: { parallelGroups: [[PARENT_CALL]], executionOrder: [PARENT_CALL] },
    },
    { turnId: TURN },
  );
  log.push(
    SessionEventType.ToolCallStarted,
    { toolCallId: PARENT_CALL, toolName: "Agent", startedAt: new Date() },
    { turnId: TURN },
  );
  log.push(
    SessionEventType.SubagentSpawned,
    {
      agentId: "agent-1",
      agentType: "explorer",
      childSessionId: "child-1",
      description: "核对排班报错请求契约",
      parentToolCallId: PARENT_CALL,
      status: "running",
      ...spawn,
    },
    { turnId: TURN },
  );
}

function mirroredTool(log: EventLog, childToolCallId: string, agentId = "agent-1"): SessionEvent {
  return log.push(
    SessionEventType.ToolCallScheduled,
    {
      agentId,
      agentType: "explorer",
      childSessionId: "child-1",
      childToolCallId,
      description: "核对排班报错请求契约",
      parentToolCallId: PARENT_CALL,
      source: "subagent",
      toolCallId: `tool_subagent_${agentId}_${childToolCallId}`,
      toolName: "Read",
      input: { path: "README.md" },
      schedule: { parallelGroups: [], executionOrder: [] },
    },
    { turnId: TURN },
  );
}

function project(log: EventLog): ProductProjection {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of log.events) projection.applyEvent(event);
  return projection;
}

function subagentRow(projection: ProductProjection): SubagentRow {
  const row = projection.getSnapshot().rows.window.find((item) => item.kind === "subagent");
  if (row?.kind !== "subagent") throw new Error("missing subagent row");
  return row;
}

describe("W8 subagent work card projection fields", () => {
  it("keeps model and effort from SubagentSpawned on the row and running item", () => {
    const log = new EventLog();
    startParentAgent(log, { model: "openai/gpt-6.1-sol", effort: "high" });
    const projection = project(log);

    // 展示用模型 ID 去掉 provider 前缀；档位保持原值，由 UI 决定是否本地化。
    expect(subagentRow(projection)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(projection.getSnapshot().subagents?.running[0]).toMatchObject({
      childSessionId: "child-1",
      model: "gpt-6.1-sol",
      effort: "high",
    });
    expect(conversationSnapshotSchema.safeParse(projection.getSnapshot()).success).toBe(true);
  });

  it("omits model and effort when the engine does not report them", () => {
    const log = new EventLog();
    startParentAgent(log);
    const projection = project(log);

    expect(subagentRow(projection)).not.toHaveProperty("model");
    expect(subagentRow(projection)).not.toHaveProperty("effort");
    expect(subagentRow(projection)).not.toHaveProperty("toolCallCount");
    expect(projection.getSnapshot().subagents?.running[0]).not.toHaveProperty("model");
  });

  it("counts mirrored child tool calls without adding parent tool rows", () => {
    const log = new EventLog();
    startParentAgent(log);
    const projection = project(log);

    // 镜像只在实时链路出现且每个子工具调用只 scheduled 一次，计数不需要额外的去重侧表。
    projection.applyEvent(mirroredTool(log, "call_child_read"));
    projection.applyEvent(mirroredTool(log, "call_child_grep"));

    const snapshot = projection.getSnapshot();
    expect(subagentRow(projection).toolCallCount).toBe(2);
    expect(snapshot.subagents?.running[0]?.toolCallCount).toBe(2);
    expect(
      snapshot.rows.window.filter(
        (row) => row.kind === "toolCall" && row.toolCallId.startsWith("tool_subagent_"),
      ),
    ).toEqual([]);
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("keeps counting background child tools after the parent turn finished", () => {
    const log = new EventLog();
    startParentAgent(log, { background: true });
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId: PARENT_CALL,
        result: { success: true, content: "Async agent launched successfully." },
        duration: 1,
      },
      { turnId: TURN },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "ok", tokenCount: 1, toolCallCount: 1, duration: 10, resultType: "success" },
      { turnId: TURN },
    );
    const projection = project(log);
    expect(projection.getSnapshot().control.phase).not.toBe("running");

    projection.applyEvent(mirroredTool(log, "call_child_bash"));

    expect(subagentRow(projection).toolCallCount).toBe(1);
  });

  it("uses SubagentStopped.totalToolUseCount as the final count and resets on resume", () => {
    const log = new EventLog();
    startParentAgent(log);
    const projection = project(log);
    projection.applyEvent(mirroredTool(log, "call_child_read"));

    projection.applyEvent(
      log.push(
        SessionEventType.SubagentStopped,
        {
          agentId: "agent-1",
          agentType: "explorer",
          childSessionId: "child-1",
          parentToolCallId: PARENT_CALL,
          status: "completed",
          totalToolUseCount: 9,
        },
        { turnId: TURN },
      ),
    );
    expect(subagentRow(projection)).toMatchObject({ status: "success", toolCallCount: 9 });

    projection.applyEvent(
      log.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-1",
          agentType: "explorer",
          background: true,
          childSessionId: "child-1",
          description: "继续",
          parentToolCallId: "call_send_message",
          resumed: true,
          status: "running",
        },
        { turnId: TURN },
      ),
    );
    // resume 是新一次运行：步骤数只描述当前这次运行，未知时不显示旧值。
    expect(subagentRow(projection).status).toBe("running");
    expect(subagentRow(projection)).not.toHaveProperty("toolCallCount");
    projection.applyEvent(mirroredTool(log, "call_child_read_again"));
    expect(subagentRow(projection).toolCallCount).toBe(1);
  });


  it("旧执行迟到的停止事件不能关闭同一子任务的新执行", () => {
    const log = new EventLog();
    startParentAgent(log);
    const projection = project(log);
    const stop = (call: string) => log.push(SessionEventType.SubagentStopped, {
      agentId: "agent-1", childSessionId: "child-1", parentToolCallId: call, status: "completed",
    }, { turnId: TURN });
    projection.applyEvent(stop(PARENT_CALL));
    projection.applyEvent(log.push(SessionEventType.SubagentSpawned, {
      agentId: "agent-1", childSessionId: "child-1", parentToolCallId: "call-resume", resumed: true, status: "running",
    }, { turnId: TURN }));
    projection.applyEventAtomically(stop(PARENT_CALL), () => true);
    expect(subagentRow(projection).status).toBe("running");
    expect(subagentRow(projection)).not.toHaveProperty("endedAt");
    projection.applyEventAtomically(stop("call-resume"), () => true);
    expect(subagentRow(projection).status).toBe("success");
    expect(subagentRow(project(log)).status).toBe("success");
  });


  it.each(["agent-1", "child-1"])("旧后台终态不能关闭新执行的可停工作：%s", (workId) => {
    const log = new EventLog(); startParentAgent(log);
    const projection = project(log);
    projection.applyEvent(log.push(SessionEventType.SubagentSpawned, {
      agentId: "agent-1", childSessionId: "child-1", parentToolCallId: "call-resume", resumed: true, background: true, status: "running",
    }, { turnId: TURN }));
    projection.applyEvent(log.push(SessionEventType.BackgroundTaskStarted, { taskId: workId, toolCallId: "call-resume", childSessionId: "child-1", taskKind: "subagent", status: "running", cancellable: true }, { turnId: TURN }));
    projection.applyEventAtomically(log.push(SessionEventType.BackgroundTaskCompleted, { taskId: workId, toolCallId: PARENT_CALL, childSessionId: "child-1", taskKind: "subagent", status: "completed", cancellable: false }, { turnId: TURN }), () => true);
    expect(projection.getSnapshot().backgroundWorks.find((work) => work.workId === workId)).toMatchObject({ status: "running", cancellable: true });
  });

  it("ignores mirrored tools for unknown subagents", () => {
    const log = new EventLog();
    startParentAgent(log);
    const projection = project(log);

    expect(projection.applyEvent(mirroredTool(log, "call_child_read", "agent-unknown"))).toEqual(
      [],
    );
    expect(subagentRow(projection)).not.toHaveProperty("toolCallCount");
  });
});
