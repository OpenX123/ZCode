import { describe, expect, it, vi } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function event(type: SessionEvent["type"], payload: unknown, sequenceNumber: number): SessionEvent {
  return {
    id: `e-${sequenceNumber}`,
    sessionId: "s1",
    traceId: "trace-1",
    turnId: "turn-1",
    timestamp: new Date(sequenceNumber * 1000),
    type,
    payload,
    sequenceNumber,
  } as SessionEvent;
}

const options = [
  {
    id: "model",
    name: "模型",
    currentValue: "opus",
    options: [
      { value: "opus", name: "Opus" },
      { value: "sonnet", name: "Sonnet" },
    ],
  },
];

function host(engine: "zcode" | "claude-code") {
  const setEngineConfigOption = vi.fn(async () => options);
  const prepareExternalEngineSession = vi.fn(async () => {});
  const record = {
    app: {
      sessionId: "s1",
      runtime: {
        getSessionEngine: () => engine,
        setEngineConfigOption,
        prepareExternalEngineSession,
      },
    },
  } as unknown as V4SessionRecordView;
  return {
    service: { getRecord: () => record } as V4CommandCoreHost,
    setEngineConfigOption,
    prepareExternalEngineSession,
  };
}

function command(type: CommandEnvelope["type"], payload = {}): CommandEnvelope {
  return { type, payload, sessionId: "s1", commandId: "c1", baseRevision: 0 } as CommandEnvelope;
}

describe("外部引擎 V4 接线", () => {
  it("ACP 配置事件进入实时投影并在后续运行态变化后仍禁用历史改写", () => {
    const projection = new ProductProjection("s1", "epoch");
    projection.seedConfig({ engine: "claude-code", engineConfigOptions: [] });
    projection.applyEvent(
      event(
        SessionEventType.ExternalEngineConfigUpdated,
        { engine: "claude-code", engineConfigOptions: options },
        1,
      ),
    );
    projection.applyEvent(event(SessionEventType.TurnStarted, { turnNumber: 1, input: "你好" }, 2));
    const snapshot = projection.getSnapshot();
    expect(snapshot.config.engineConfigOptions).toEqual(options);
    expect(snapshot.availability.fork).toEqual({
      allowed: false,
      reasonCode: "external_engine_unsupported",
    });
    expect(snapshot.availability.compact.allowed).toBe(false);
    expect(snapshot.availability.switchModelConfig.allowed).toBe(false);
    expect(
      snapshot.rows.window.every(
        (row) =>
          !row.actions?.canEdit &&
          !row.actions?.canRetry &&
          !row.actions?.canFork &&
          !row.actions?.canRewindFiles,
      ),
    ).toBe(true);
  });

  it("配置恢复失败保留已保存选择，重试仍走同一原生准备入口", async () => {
    const projection = new ProductProjection("s1", "restore");
    for (const [index, engineConfigState] of ["connecting", "error", "ready"].entries()) {
      projection.applyEvent(
        event(
          SessionEventType.ExternalEngineConfigUpdated,
          {
            engine: "claude-code",
            engineConfigOptions: options,
            engineConfigState,
            ...(engineConfigState === "error"
              ? {
                  engineConfigError: {
                    code: "authentication",
                    method: "session/resume",
                    rpcCode: -32000,
                  },
                }
              : {}),
          },
          index + 1,
        ),
      );
      expect(projection.getSnapshot().config).toMatchObject({
        engineConfigOptions: options,
        engineConfigState,
      });
      if (engineConfigState === "error")
        expect(projection.getSnapshot().config.engineConfigError).toEqual({
          code: "authentication",
          method: "session/resume",
          rpcCode: -32000,
        });
    }
    expect(projection.getSnapshot().config.engineConfigError).toBeUndefined();
    const test = host("claude-code");
    await new V4CommandExecutor(test.service).execute(command("prepareExternalEngineSession"));
    expect(test.prepareExternalEngineSession).toHaveBeenCalledExactlyOnceWith();
    expect(test.setEngineConfigOption).not.toHaveBeenCalled();
  });

  it("配置切换只调用外部引擎接口，不走 Registry", async () => {
    const test = host("claude-code");
    await new V4CommandExecutor(test.service).execute(
      command("setEngineConfigOption", { configId: "model", value: "sonnet" }),
    );
    expect(test.setEngineConfigOption).toHaveBeenCalledWith("model", "sonnet");
  });

  it.each([
    "compact",
    "switchModelConfig",
    "switchCollaborationMode",
    "editUserQuery",
    "retryTurn",
    "applyFileRewind",
    "forkAssistant",
  ] as const)("直接提交 %s 也拒绝", async (type) => {
    const test = host("claude-code");
    await expect(new V4CommandExecutor(test.service).execute(command(type))).rejects.toMatchObject({
      reasonCode: "external_engine_unsupported",
    });
    expect(test.setEngineConfigOption).not.toHaveBeenCalled();
  });
});

it("外部工具的迟到进度不能覆盖终态参数或输出", () => {
  const projection = new ProductProjection("s1", "late-progress");
  projection.applyEvent(event(SessionEventType.TurnStarted, { turnNumber: 1, input: "test" }, 1));
  projection.applyEvent(
    event(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "bash",
        toolName: "Bash",
        input: { command: "pwd" },
        schedule: { parallelGroups: [], executionOrder: ["bash"] },
      },
      2,
    ),
  );
  projection.applyEvent(
    event(SessionEventType.ToolCallStarted, { toolCallId: "bash", startedAt: new Date(3000) }, 3),
  );
  projection.applyEvent(
    event(
      SessionEventType.ToolCallResult,
      { toolCallId: "bash", result: { success: true, content: "done" }, duration: 1 },
      4,
    ),
  );
  projection.applyEvent(
    event(
      SessionEventType.ToolCallProgress,
      { toolCallId: "bash", input: { command: "stale" }, output: "stale", activityText: "stale" },
      5,
    ),
  );
  expect(projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall")).toMatchObject(
    { status: "success", input: { command: "pwd" }, output: { text: "done" } },
  );
});
