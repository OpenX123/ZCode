import { describe, expect, test, vi } from "vitest";
import {
  ExternalEngineConnectionError,
  type ExternalEnginePermissionRequest,
  type ExternalEnginePort,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { runExternalEngineTurn } from "../src/external-engine/turn.js";
import {
  publishExternalEngineConfig,
  publishExternalEngineFailureNotice,
} from "../src/external-engine/session.js";
import { setup } from "./helpers/external-engine-runtime.js";

type RunTurn = ExternalEnginePort["runTurn"];
type Turn = Parameters<RunTurn>[0];

// claude-agent-acp 0.95.0：ExitPlanMode 审批只在非标准 name 字段带工具名，标题 "Approve Plan"，
// 选项顺序来自 permissions/options/tools.js（有计划时清空上下文项排第一）。
function claudeExitPlanRequest(): ExternalEnginePermissionRequest {
  return {
    toolCall: {
      toolCallId: "toolu_fixture_plan",
      name: "ExitPlanMode",
      status: "pending",
      title: "Approve Plan",
      kind: "switch_mode",
      rawInput: { plan: "# 计划\n\n先检查连接。" },
      content: [{ type: "content", content: { type: "text", text: "# 计划" } }],
    },
    options: [
      {
        optionId: "exit-plan-clear-auto",
        name: "Yes, clear context (12% used) and use auto mode",
        kind: "allow_always",
      },
      { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
      { optionId: "exit-plan-bypass", name: "Yes, and bypass permissions", kind: "allow_always" },
      { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
      { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
    ],
  };
}

const claudeModes = (currentValue: string) => [
  {
    id: "mode",
    name: "Mode",
    currentValue,
    options: ["default", "acceptEdits", "auto", "bypassPermissions", "plan"].map((value) => ({
      value,
      name: value,
    })),
  },
];

function permissionRuntime(
  decide: (request: { nativeOptions?: unknown }) => {
    decision: "allow" | "deny";
    nativeOptionId?: string;
  },
) {
  const fixture = setup([]);
  const requestPermission = vi.fn(async (request: { nativeOptions?: unknown }) => decide(request));
  fixture.runtime.permissionBroker = {
    requestPermission,
  } as unknown as AgentRuntimeInternal["permissionBroker"];
  return { ...fixture, requestPermission };
}

describe("外部引擎结构化失败", () => {
  test("typed 终态失败走请求失败路径：轮次失败、诊断写入 assistant.error，迟到重试不再发布", async () => {
    const { runtime, input, events } = setup([]);
    const failure = {
      code: "provider" as const,
      method: "session/prompt" as const,
      httpStatus: 502,
      message: "unexpected status 502 Bad Gateway: Bad gateway",
      url: "https://gateway.example.test/v1/responses",
      requestId: "fixture-request",
      failureId: "codex-turn-1:error",
      retryable: true,
    };
    runtime.externalEnginePort!.runTurn = vi.fn(async () => ({
      stopReason: "end_turn",
      failure,
    }));
    await expect(runExternalEngineTurn(runtime, input)).rejects.toMatchObject({
      failure: { ...failure, method: "session/prompt" },
    });
    expect(events.filter((event) => event.type === "external_engine_failure_updated")).toEqual([
      expect.objectContaining({ payload: { failure, retrying: false } }),
    ]);
    const persisted = vi.mocked(runtime.persistAssistantMessage).mock.calls.at(-1)?.[3] as {
      error?: { data?: Record<string, unknown> };
    };
    expect(persisted.error?.data).toMatchObject({
      code: "external_engine.provider",
      failure: { httpStatus: 502, requestId: "fixture-request" },
      attribution: { source: "provider", statusCode: 502, retryable: true },
    });
    const before = events.length;
    await publishExternalEngineFailureNotice(
      runtime,
      { severity: "warning", revision: 9, failure: { ...failure, attempt: 3 } },
      input.traceContext,
    );
    expect(events).toHaveLength(before);
  });

  test("RPC 请求失败同样写入 assistant.error；用户停止不写失败", async () => {
    const { runtime, input } = setup([]);
    runtime.externalEnginePort!.runTurn = vi.fn(async () => {
      throw new ExternalEngineConnectionError(
        { code: "provider", method: "session/prompt", httpStatus: 502, requestId: "req_fixture01" },
        "API Error: 502",
      );
    });
    await expect(runExternalEngineTurn(runtime, input)).rejects.toThrow("API Error: 502");
    const persisted = vi.mocked(runtime.persistAssistantMessage).mock.calls.at(-1)?.[3] as {
      error?: { data?: Record<string, unknown> };
    };
    expect(persisted.error?.data).toMatchObject({ failure: { requestId: "req_fixture01" } });
  });

  test("adapter 已死时先发布 connecting，再在准备完成后回到 ready", async () => {
    const { runtime, input, events } = setup([]);
    runtime.externalEnginePort!.isSessionConnected = () => false;
    const order: string[] = [];
    runtime.externalEnginePort!.prepareSession = vi.fn(async () => {
      order.push("prepare");
    });
    vi.mocked(runtime.appendEvent).mockImplementation(async (event) => {
      events.push(event as unknown as Record<string, unknown>);
      const payload = (event as { payload: { engineConfigState?: string } }).payload;
      if ((event as { type: string }).type === "external_engine_config_updated")
        order.push(String(payload.engineConfigState));
    });
    await runExternalEngineTurn(runtime, input);
    // 之后的 ready 来自原生配置回流（夹具 runTurn 的 onConfigOptions）。
    expect(order.slice(0, 3)).toEqual(["connecting", "prepare", "ready"]);
  });
});

describe("Claude 原生计划审批", () => {
  test("按 name/标题识别 ExitPlanMode，主按钮回到进入计划前的 auto，从不隐式清空上下文", async () => {
    const { runtime, input, events, requestPermission } = permissionRuntime(() => ({
      decision: "allow",
    }));
    await publishExternalEngineConfig(runtime, claudeModes("auto"), input.traceContext);
    await publishExternalEngineConfig(runtime, claudeModes("plan"), input.traceContext);
    const outcomes: unknown[] = [];
    runtime.externalEnginePort!.runTurn = vi.fn(async (turn: Turn) => {
      outcomes.push(await turn.requestPermission(claudeExitPlanRequest()));
      return { stopReason: "end_turn" };
    });
    await runExternalEngineTurn(runtime, input);
    expect(outcomes).toEqual([{ outcome: "selected", optionId: "exit-plan-auto" }]);
    const requested = events.find((event) => event.type === "permission_requested");
    expect(requested).toMatchObject({
      payload: { toolName: "ExitPlanMode", approvalMode: "user-once" },
    });
    expect((requested?.payload as { nativeOptions: unknown }).nativeOptions).toEqual([
      expect.objectContaining({ optionId: "exit-plan-clear-auto", clearsContext: true }),
      expect.objectContaining({ optionId: "exit-plan-auto", recommended: true }),
      expect.objectContaining({ optionId: "exit-plan-bypass" }),
      expect.objectContaining({ optionId: "exit-plan-default" }),
      expect.objectContaining({ optionId: "reject", kind: "reject_once" }),
    ]);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  test("未知的进入前模式回退 manually approve edits；显式选择的原生 optionId 原样回传", async () => {
    const choices = [
      { decision: "allow" as const },
      { decision: "allow" as const, nativeOptionId: "exit-plan-bypass" },
      { decision: "deny" as const },
      // 决策与原生选项不一致时不采纳该 optionId。
      { decision: "deny" as const, nativeOptionId: "exit-plan-auto" },
    ];
    const { runtime, input } = permissionRuntime(() => choices.shift()!);
    const outcomes: unknown[] = [];
    runtime.externalEnginePort!.runTurn = vi.fn(async (turn: Turn) => {
      for (let index = 0; index < 4; index++)
        outcomes.push(await turn.requestPermission(claudeExitPlanRequest()));
      return { stopReason: "end_turn" };
    });
    await runExternalEngineTurn(runtime, input);
    expect(outcomes).toEqual([
      { outcome: "selected", optionId: "exit-plan-default" },
      { outcome: "selected", optionId: "exit-plan-bypass" },
      { outcome: "selected", optionId: "reject" },
      { outcome: "selected", optionId: "reject" },
    ]);
  });

  test("审批等待中停止：发布 PermissionResolved(cancelled) 并向 adapter 回复 cancelled", async () => {
    const { runtime, input, events } = setup([]);
    const controller = new AbortController();
    input.signal = controller.signal;
    runtime.permissionBroker = {
      requestPermission: vi.fn(
        (_request: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("cancelled"))),
          ),
      ),
    } as unknown as AgentRuntimeInternal["permissionBroker"];
    let outcome: unknown;
    runtime.externalEnginePort!.runTurn = vi.fn(async (turn: Turn) => {
      const pending = turn.requestPermission({
        toolCall: {
          toolCallId: "plan-review:native-plan",
          kind: "switch_mode",
          rawInput: { plan: "# 计划" },
        },
        options: [
          { optionId: "implement_plan", kind: "allow_once", name: "Implement" },
          { optionId: "revise_plan", kind: "reject_once", name: "Revise" },
        ],
      });
      controller.abort();
      outcome = await pending;
      return { stopReason: "cancelled" };
    });
    await expect(runExternalEngineTurn(runtime, input)).rejects.toThrow();
    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(events.filter((event) => event.type === "permission_resolved")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          toolCallId: "plan-review:native-plan",
          decision: "deny",
          reason: "cancelled",
        }),
      }),
    ]);
  });

  test("adapter 断联时取消在途审批，结束事实先于轮次失败发布", async () => {
    const { runtime, input, events } = setup([]);
    runtime.permissionBroker = {
      requestPermission: vi.fn(
        (_request: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("cancelled"))),
          ),
      ),
    } as unknown as AgentRuntimeInternal["permissionBroker"];
    runtime.externalEnginePort!.runTurn = vi.fn(async (turn: Turn) => {
      void turn.requestPermission({
        toolCall: { toolCallId: "plan-review:lost", kind: "switch_mode", rawInput: { plan: "#" } },
        options: [{ optionId: "implement_plan", kind: "allow_once", name: "Implement" }],
      });
      await Promise.resolve();
      throw new ExternalEngineConnectionError({ code: "transport", method: "session/prompt" });
    });
    await expect(runExternalEngineTurn(runtime, input)).rejects.toBeInstanceOf(
      ExternalEngineConnectionError,
    );
    expect(events.filter((event) => event.type === "permission_resolved")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ toolCallId: "plan-review:lost", reason: "cancelled" }),
      }),
    ]);
  });
});

describe("未发审批请求的原生计划", () => {
  const collaborationModes = (currentValue: string) => [
    {
      id: "collaboration_mode",
      name: "Collaboration mode",
      currentValue,
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];

  test("计划写完且仍在 Plan 时发布切出值，下一轮开始即收回", async () => {
    const { runtime, input, events } = setup([]);
    await publishExternalEngineConfig(runtime, collaborationModes("default"), input.traceContext);
    await publishExternalEngineConfig(runtime, collaborationModes("plan"), input.traceContext);
    runtime.externalEnginePort!.runTurn = vi.fn(async (turn: Turn) => {
      await turn.onUpdate({
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "native-plan", content: "# 计划" },
      });
      return { stopReason: "end_turn" };
    });
    await runExternalEngineTurn(runtime, input);
    const plans = events.filter((event) => event.type === "external_engine_plan_updated");
    expect(plans.at(-1)).toMatchObject({
      payload: {
        plan: {
          document: { markdown: "# 计划" },
          startWithoutReview: { configId: "collaboration_mode", value: "default" },
        },
      },
    });
    runtime.externalEnginePort!.runTurn = vi.fn(async () => ({ stopReason: "end_turn" }));
    await runExternalEngineTurn(runtime, input);
    const latest = events.filter((event) => event.type === "external_engine_plan_updated").at(-1);
    expect((latest?.payload as { plan: Record<string, unknown> }).plan).not.toHaveProperty(
      "startWithoutReview",
    );
  });

  test("本轮已发计划审批时不发布无审批入口", async () => {
    const { runtime, input, events } = permissionRuntime(() => ({ decision: "deny" }));
    await publishExternalEngineConfig(runtime, collaborationModes("plan"), input.traceContext);
    runtime.externalEnginePort!.runTurn = vi.fn(async (turn: Turn) => {
      await turn.onUpdate({
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "native-plan", content: "# 计划" },
      });
      await turn.requestPermission({
        toolCall: {
          toolCallId: "plan-review:native-plan",
          kind: "switch_mode",
          rawInput: { plan: "# 计划" },
        },
        options: [
          { optionId: "implement_plan", kind: "allow_once", name: "Implement" },
          { optionId: "revise_plan", kind: "reject_once", name: "Revise" },
        ],
      });
      return { stopReason: "end_turn" };
    });
    await runExternalEngineTurn(runtime, input);
    const latest = events.filter((event) => event.type === "external_engine_plan_updated").at(-1);
    expect((latest?.payload as { plan: Record<string, unknown> }).plan).not.toHaveProperty(
      "startWithoutReview",
    );
  });
});
