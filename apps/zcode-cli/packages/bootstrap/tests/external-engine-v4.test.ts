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
  it("原生计划保留未执行清单，首次502重试可见并由真实进度收口", () => {
    const projection = new ProductProjection("s1", "native-plan-errors");
    projection.seedConfig({ engine: "codex", engineConfigOptions: [] });
    projection.applyEvent(
      event(SessionEventType.TurnStarted, { turnNumber: 1, input: "制定计划" }, 1),
    );
    projection.applyEvent(
      event(
        SessionEventType.ExternalEnginePlanUpdated,
        {
          plan: {
            items: [{ id: "one", content: "检查连接", status: "pending" }],
            document: { id: "native-plan", markdown: "# 实施计划" },
            updatedAt: 2000,
          },
        },
        2,
      ),
    );
    expect(projection.getSnapshot().plan).toMatchObject({
      items: [{ status: "pending" }],
      document: { markdown: "# 实施计划" },
    });
    projection.applyEvent(
      event(
        SessionEventType.ExternalEngineFailureUpdated,
        {
          failure: {
            code: "provider",
            httpStatus: 502,
            message: "Bad Gateway",
            requestId: "fixture-request",
          },
          retrying: true,
          attempt: 1,
        },
        3,
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toMatchObject({
      attempt: 1,
      maxAttempts: 0,
      httpStatus: 502,
      message: "Bad Gateway",
      requestId: "fixture-request",
    });
    projection.applyEvent(
      event(SessionEventType.ExternalEngineFailureUpdated, { failure: null }, 4),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();
    expect(projection.getSnapshot().plan?.items[0]?.status).toBe("pending");
  });

  it("网关终态随 TurnError 固定在失败轮末尾，运行终止后的旧重试不能复活", () => {
    const projection = new ProductProjection("s1", "terminal-provider-error");
    projection.applyEvent(event(SessionEventType.TurnStarted, { turnNumber: 1, input: "test" }, 1));
    const failure = {
      code: "provider",
      method: "session/prompt",
      httpStatus: 502,
      attempt: 2,
      maxAttempts: 5,
      message: "unexpected status 502 Bad Gateway: Bad gateway",
      url: "https://gateway.example.test/v1/responses",
      requestId: "fixture-request",
      failureId: "codex-turn-1:error",
      retryable: true,
    };
    projection.applyEvent(
      event(SessionEventType.ExternalEngineFailureUpdated, { failure, retrying: true }, 2),
    );
    // 原生展示的 2/5 → v4 maxAttempts 含首次请求，为 6。
    expect(projection.getSnapshot().control.apiRetry).toMatchObject({
      attempt: 2,
      maxAttempts: 6,
      httpStatus: 502,
      url: "https://gateway.example.test/v1/responses",
      requestId: "fixture-request",
      failureId: "codex-turn-1:error",
    });
    projection.applyEvent(
      event(SessionEventType.ExternalEngineFailureUpdated, { failure, retrying: false }, 3),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();
    projection.applyEvent(
      event(
        SessionEventType.TurnError,
        {
          error: {
            type: "UnknownError",
            code: "external_engine_connection_failed",
            message: failure.message,
            failure,
          },
          turnPhase: "model",
        },
        4,
      ),
    );
    const snapshot = projection.getSnapshot();
    const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      state: "failed",
      failure: {
        code: "external_engine.provider",
        summary: failure.message,
        source: "provider",
        httpStatus: 502,
        url: "https://gateway.example.test/v1/responses",
        requestId: "fixture-request",
        failureId: "codex-turn-1:error",
      },
    });
    expect(snapshot.control.lastError).toMatchObject({ turnId: header?.turnId });
    projection.applyEvent(
      event(SessionEventType.ExternalEngineFailureUpdated, { failure, retrying: true }, 5),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();
  });

  it("内置引擎重试投影状态码、脱敏原因、上游请求 ID 与收窄 URL", () => {
    const projection = new ProductProjection("s1", "builtin-retry");
    projection.applyEvent(event(SessionEventType.TurnStarted, { turnNumber: 1, input: "test" }, 1));
    projection.applyEvent(
      event(
        SessionEventType.ModelNetworkStatus,
        {
          type: "model_retry_scheduled",
          attempt: 1,
          maxAttempts: 11,
          delayMs: 1000,
          nextAttempt: 2,
          reason: "server_error",
          message: "Provider request failed. token=fixture-token",
          statusCode: 503,
          providerRequestId: "provider-req-1",
          baseURL: "https://api.example.test/v4?api_key=fixture-secret",
          requestId: "internal-req",
          providerId: "p",
          modelId: "m",
          transport: "sse",
          timestamp: new Date(1000).toISOString(),
          traceId: "trace-1",
        },
        2,
      ),
    );
    const retry = projection.getSnapshot().control.apiRetry;
    expect(retry).toMatchObject({
      attempt: 1,
      maxAttempts: 11,
      httpStatus: 503,
      requestId: "provider-req-1",
      url: "https://api.example.test/v4",
    });
    expect(JSON.stringify(retry)).not.toContain("fixture-token");
    expect(JSON.stringify(retry)).not.toContain("fixture-secret");
  });

  it("内置引擎 TurnError 的归因状态码进入失败轮；ExitPlanMode 原生选项进入审批交互", () => {
    const projection = new ProductProjection("s1", "builtin-turn-error");
    projection.applyEvent(event(SessionEventType.TurnStarted, { turnNumber: 1, input: "test" }, 1));
    projection.applyEvent(
      event(
        SessionEventType.PermissionRequested,
        {
          requestId: "perm-1",
          toolCallId: "toolu_plan",
          toolName: "ExitPlanMode",
          riskLevel: "low",
          reason: "计划已准备好",
          input: { plan: "# 计划" },
          approvalMode: "user-once",
          nativeOptions: [
            {
              optionId: "exit-plan-clear-auto",
              label: "Yes, clear context",
              kind: "allow_always",
              clearsContext: true,
            },
            {
              optionId: "exit-plan-auto",
              label: "Yes, and use auto mode",
              kind: "allow_always",
              recommended: true,
            },
            { optionId: "reject", label: "No, keep planning", kind: "reject_once" },
          ],
        },
        2,
      ),
    );
    const pending = projection.getSnapshot().pendingInteractions[0];
    expect(pending?.payload).toMatchObject({
      kind: "userInput",
      toolName: "ExitPlanMode",
      nativeOptions: [
        { optionId: "exit-plan-clear-auto", clearsContext: true },
        { optionId: "exit-plan-auto", recommended: true },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    projection.applyEvent(
      event(
        SessionEventType.TurnError,
        {
          error: {
            type: "ModelError",
            message: "Provider is overloaded.",
            attribution: { source: "provider", statusCode: 529, retryable: true },
          },
          turnPhase: "model",
        },
        3,
      ),
    );
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader"),
    ).toMatchObject({
      failure: { summary: "Provider is overloaded.", httpStatus: 529, source: "provider" },
    });
  });

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
