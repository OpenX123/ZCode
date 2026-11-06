import { describe, expect, test, vi } from "vitest";
import {
  createRootTraceContext,
  observeLocalTurnPreparation,
  type ExternalEnginePort,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { runExternalEngineTurn } from "../src/external-engine/turn.js";
import {
  publishExternalEngineSessionUpdate,
  restoreExternalEngineConfig,
} from "../src/external-engine/session.js";
import { setup } from "./helpers/external-engine-runtime.js";

describe("外部引擎原生计划与错误", () => {
  test("先等待引擎准备，完成后才交付唯一prompt", async () => {
    const { runtime, input } = setup([]);
    input.traceContext = {
      ...input.traceContext,
      queryId: "external-timing" as never,
      sessionId: runtime.sessionId,
      turnId: input.turnId,
    };
    const stages: string[] = [];
    const unsubscribe = observeLocalTurnPreparation("external-timing", (fact) => {
      stages.push(`${fact.stage}:${fact.end === undefined ? "start" : "end"}`);
    });
    let ready!: () => void;
    const preparing = new Promise<void>((resolve) => {
      ready = resolve;
    });
    runtime.externalEnginePort!.prepareSession = vi.fn(() => preparing);
    const runTurn = vi.spyOn(runtime.externalEnginePort!, "runTurn");
    const completion = runExternalEngineTurn(runtime, input);
    await vi.waitFor(() =>
      expect(runtime.externalEnginePort!.prepareSession).toHaveBeenCalledOnce(),
    );
    expect(runTurn).not.toHaveBeenCalled();
    ready();
    await completion;
    expect(runTurn).toHaveBeenCalledOnce();
    expect(stages).toEqual([
      "engine_prepare:start",
      "engine_prepare:end",
      "request:start",
      "request:end",
    ]);
    unsubscribe();
  });
  test("原生计划清单与文档进入唯一计划投影，pending清单不阻止计划审批", async () => {
    const { runtime, events } = setup([]);
    const trace = createRootTraceContext();
    await publishExternalEngineSessionUpdate(
      runtime,
      {
        sessionUpdate: "plan",
        entries: [{ content: "优化连接", status: "pending", priority: "high" }],
      },
      trace,
    );
    await publishExternalEngineSessionUpdate(
      runtime,
      {
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "native-plan", content: "# 计划\n\n优化连接。" },
      },
      trace,
    );
    expect(events.at(-1)).toMatchObject({
      type: "external_engine_plan_updated",
      payload: {
        plan: {
          items: [{ content: "优化连接", status: "pending" }],
          document: { id: "native-plan", markdown: "# 计划\n\n优化连接。" },
        },
      },
    });
    await publishExternalEngineSessionUpdate(
      runtime,
      { sessionUpdate: "plan_removed", planId: "native-plan" },
      trace,
    );
    expect((events.at(-1)?.payload as { plan: unknown }).plan).not.toHaveProperty("document");
  });

  test("Codex重试错误发布安全诊断，正文恢复时清除活动错误", async () => {
    const { runtime, input, events } = setup([
      {
        sessionUpdate: "session_info_update",
        _meta: {
          codex: {
            error: {
              message: "unexpected status 502 Bad Gateway; request id: fixture-request",
              codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
              willRetry: true,
            },
          },
        },
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已恢复" } },
    ]);
    await runExternalEngineTurn(runtime, input);
    const failures = events.filter((event) => event.type === "external_engine_failure_updated");
    expect(failures[0]).toMatchObject({
      payload: { retrying: true, failure: { httpStatus: 502, requestId: "fixture-request" } },
    });
    expect(failures.at(-1)).toMatchObject({ payload: { failure: null } });
  });

  test("Codex原生计划审批复用显式ExitPlanMode，回复原生选项且不另发实现输入", async () => {
    const { runtime, input, events } = setup([]);
    const requestPermission = vi.fn(async () => ({ decision: "allow" as const }));
    runtime.permissionBroker = { requestPermission } as AgentRuntimeInternal["permissionBroker"];
    const outcomes: unknown[] = [];
    const runTurn = vi.fn(async (turn: Parameters<ExternalEnginePort["runTurn"]>[0]) => {
      outcomes.push(
        await turn.requestPermission({
          toolCall: {
            toolCallId: "plan-review:native-plan",
            title: "Implement this plan?",
            kind: "switch_mode",
            rawInput: { plan: "# 实施计划" },
          },
          options: [
            { optionId: "implement_plan", kind: "allow_once", name: "Implement" },
            { optionId: "revise_plan", kind: "reject_once", name: "Revise" },
          ],
        }),
      );
      return { stopReason: "end_turn" };
    });
    runtime.externalEnginePort!.runTurn = runTurn;
    await runExternalEngineTurn(runtime, input);
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "ExitPlanMode",
        approvalMode: "user-once",
        input: { plan: "# 实施计划" },
      }),
      expect.anything(),
    );
    expect(outcomes).toEqual([{ outcome: "selected", optionId: "implement_plan" }]);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "permission_requested")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ toolName: "ExitPlanMode", approvalMode: "user-once" }),
      }),
    ]);
    expect(events.filter((event) => event.type === "permission_resolved")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ decision: "allow" }) }),
    ]);
  });
  test("拒绝原生计划只回复修改选项，未触发第二次prompt", async () => {
    const { runtime, input } = setup([]);
    runtime.permissionBroker = {
      requestPermission: vi.fn(async () => ({ decision: "deny" as const })),
    } as unknown as AgentRuntimeInternal["permissionBroker"];
    const runTurn = vi.fn(async (turn: Parameters<ExternalEnginePort["runTurn"]>[0]) => {
      expect(
        await turn.requestPermission({
          toolCall: {
            toolCallId: "plan-review:one",
            kind: "switch_mode",
            rawInput: { plan: "# 计划" },
          },
          options: [
            { optionId: "implement_plan", kind: "allow_once", name: "Implement" },
            { optionId: "revise_plan", kind: "reject_once", name: "Revise" },
          ],
        }),
      ).toEqual({ outcome: "selected", optionId: "revise_plan" });
      return { stopReason: "end_turn" };
    });
    runtime.externalEnginePort!.runTurn = runTurn;
    await runExternalEngineTurn(runtime, input);
    expect(runTurn).toHaveBeenCalledOnce();
  });
  test("原生文档与清单从既有session entry恢复，不清空已确认配置", async () => {
    const { runtime, events } = setup([]);
    runtime.sessionStore!.sessionEntries = vi.fn(async () => [
      {
        type: "external_engine_config",
        data: { engine: "codex", engineConfigOptions: [], connectionProfileId: "inherit" },
      },
      {
        type: "external_engine_plan",
        data: {
          items: [{ id: "one", content: "检查连接", status: "pending" }],
          updatedAt: 100,
          document: { id: "native-plan", markdown: "# 计划" },
        },
      },
    ]) as NonNullable<typeof runtime.sessionStore>["sessionEntries"];
    await restoreExternalEngineConfig(runtime, createRootTraceContext());
    expect(runtime.engineConnectionProfileId).toBe("inherit");
    expect(events.at(-1)).toMatchObject({
      type: "external_engine_plan_updated",
      payload: { plan: { document: { markdown: "# 计划" }, items: [{ status: "pending" }] } },
    });
  });
});
