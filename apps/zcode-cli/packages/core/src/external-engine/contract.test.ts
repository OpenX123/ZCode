import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
  createMessageId,
  SessionEventType,
  ExternalEngineConnectionError,
  type ExternalEnginePort,
  parseCompletedToolPartMetadata,
  type MessagePart,
} from "@zcode/contracts";
import { TurnMachineImpl } from "../runtime/deps.js";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import { runExternalEngineTurn, selectExternalPermissionOption } from "./turn.js";
function setup(updates: Record<string, unknown>[]) {
  const parts = new Map<string, MessagePart>();
  const events: Record<string, unknown>[] = [];
  const runtime = {
    sessionId: createSessionId(),
    config: { engine: "codex" },
    engineConfigOptions: [],
    sessionPersisted: true,
    workingDirectory: "/workspace",
    isRemoteWorkspace: () => false,
    sessionStore: { updateSession: vi.fn() },
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    appendEvent: vi.fn(async (event: Record<string, unknown>) => {
      events.push(event);
    }),
    persistAssistantMessage: vi.fn(),
    persistPart: vi.fn(async (part: MessagePart) => {
      parts.set(String(part.id), structuredClone(part));
    }),
    externalEnginePort: {
      async runTurn(
        input: Parameters<NonNullable<AgentRuntimeInternal["externalEnginePort"]>["runTurn"]>[0],
      ) {
        await input.onSession("external-example");
        await input.onConfigOptions([]);
        for (const update of updates) await input.onUpdate(update);
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } };
      },
    },
  } as unknown as AgentRuntimeInternal;
  const traceContext = createRootTraceContext();
  const turnId = createTurnId();
  return {
    parts,
    events,
    runtime,
    input: {
      input: "example",
      attachments: [],
      turnId,
      userMessageId: createMessageId(),
      traceContext,
      signal: new AbortController().signal,
      events: [],
      turnMachine: TurnMachineImpl.create(
        runtime.sessionId,
        0,
        "example",
        traceContext.traceId,
        turnId,
      ),
    },
  };
}
describe("外部引擎事件与 transcript", () => {
  test.each(["claude", "codex"])("%s 脱敏真实帧保留diff直到终态并可冷恢复", async (engine) => {
    const updates = JSON.parse(
      await readFile(new URL(`./fixtures/${engine}-updates.json`, import.meta.url), "utf8"),
    ) as Record<string, unknown>[];
    const { runtime, input, parts, events } = setup(updates);
    const result = await runExternalEngineTurn(runtime, input);
    expect(result.modelResponse).toBe("示例正文");
    expect(events.some((event) => event.type === SessionEventType.ExternalEngineUsageUpdated)).toBe(
      true,
    );
    expect(
      events.some((event) => event.type === SessionEventType.ExternalEngineCommandsUpdated),
    ).toBe(true);
    const tools = [...parts.values()].filter((part) => part.type === "tool");
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.state.status).toMatch(/completed|error/);
    const metadata =
      "metadata" in tool.state ? parseCompletedToolPartMetadata(tool.state.metadata) : undefined;
    expect(metadata?.display).toMatchObject({
      kind: "file_diff",
      filePath: "/workspace/example.txt",
      additions: 1,
      deletions: 1,
    });
    expect(runtime.sessionStore?.updateSession).toHaveBeenCalledWith({
      id: runtime.sessionId,
      externalSessionId: "external-example",
    });
  });
  test("缺少引擎对应允许选项时取消，不猜测optionId", () => {
    const request = {
      toolCall: { toolCallId: "one" },
      options: [{ kind: "reject_once" as const, optionId: "original-deny", name: "No" }],
    };
    expect(selectExternalPermissionOption(request, "allow", false)).toEqual({
      outcome: "cancelled",
    });
    expect(selectExternalPermissionOption(request, "deny", false)).toEqual({
      outcome: "selected",
      optionId: "original-deny",
    });
  });
  test("引擎异常时将运行中工具收口为失败", async () => {
    const { runtime, input, parts } = setup([
      { sessionUpdate: "tool_call", toolCallId: "pending", kind: "execute", status: "in_progress" },
    ]);
    const run = runtime.externalEnginePort!.runTurn;
    runtime.externalEnginePort!.runTurn = async (value) => {
      await run(value);
      throw new Error("engine failed");
    };
    await expect(runExternalEngineTurn(runtime, input)).rejects.toThrow("engine failed");
    expect([...parts.values()].find((part) => part.type === "tool")?.state.status).toBe("error");
  });
});

test.each([
  ["claude-code", "transport"],
  ["codex", "transport"],
  ["codex", "cancelled-callback"],
] as const)("%s 停止时 %s 故障自动恢复原会话，不重发 prompt", async (engine, failure) => {
  const { runtime, input, events } = setup([]);
  runtime.config.engine = engine;
  runtime.config.externalSessionId = "original-session";
  const abort = new AbortController();
  input.signal = abort.signal;
  const runTurn = vi.fn(async () => {
    abort.abort();
    if (failure === "cancelled-callback") throw new Error("Permission cancelled");
    throw new ExternalEngineConnectionError({ code: "transport", method: "session/prompt" });
  });
  const prepareSession = vi.fn<ExternalEnginePort["prepareSession"]>(async () => {});
  runtime.externalEnginePort!.runTurn = runTurn;
  runtime.externalEnginePort!.prepareSession = prepareSession;
  await expect(runExternalEngineTurn(runtime, input)).rejects.toThrow();
  expect(prepareSession).toHaveBeenCalledWith(
    expect.objectContaining({ externalSessionId: "original-session" }),
  );
  expect(prepareSession.mock.calls[0]?.[0]?.signal.aborted).toBe(false);
  expect(runtime.engineConfigState).toBe("ready");
  expect(
    events
      .filter((event) => event.type === SessionEventType.ExternalEngineConfigUpdated)
      .map((event) => (event.payload as Record<string, unknown>).engineConfigState),
  ).toEqual(["connecting", "ready"]);
  expect(runTurn).toHaveBeenCalledTimes(1);
});

test.each(["恢复失败", "正在关闭", "正常运行故障"])("停止恢复边界：%s", async (scenario) => {
  const { runtime, input } = setup([]);
  runtime.config.externalSessionId = "original-session";
  runtime.shuttingDown = scenario === "正在关闭";
  const abort = new AbortController();
  input.signal = abort.signal;
  const prepareSession = vi.fn<ExternalEnginePort["prepareSession"]>(async () => {
    throw new ExternalEngineConnectionError({ code: "authentication" });
  });
  runtime.externalEnginePort!.prepareSession = prepareSession;
  runtime.externalEnginePort!.runTurn = vi.fn(async () => {
    if (scenario !== "正常运行故障") abort.abort();
    throw new ExternalEngineConnectionError({ code: "transport", method: "session/prompt" });
  });
  await expect(runExternalEngineTurn(runtime, input)).rejects.toThrow();
  expect(prepareSession).toHaveBeenCalledTimes(scenario === "恢复失败" ? 1 : 0);
  if (scenario !== "正在关闭") expect(runtime.engineConfigState).toBe("error");
});

test("发布连接状态期间开始关闭，不再启动恢复进程", async () => {
  const { prepareExternalEngineSession } = await import("./session.js");
  const { runtime } = setup([]);
  const prepareSession = vi.fn<ExternalEnginePort["prepareSession"]>();
  runtime.externalEnginePort!.prepareSession = prepareSession;
  runtime.appendEvent = vi.fn(async () => {
    runtime.shuttingDown = true;
  });
  await prepareExternalEngineSession(runtime, createRootTraceContext());
  expect(prepareSession).not.toHaveBeenCalled();
});

test("准备失败保留安全诊断，重试成功清除旧错误且不创建 turn", async () => {
  const { prepareExternalEngineSession } = await import("./session.js");
  const { ExternalEngineConnectionError } = await import("@zcode/contracts");
  const { runtime, events } = setup([]);
  runtime.externalEnginePort!.prepareSession = vi
    .fn()
    .mockRejectedValueOnce(
      new ExternalEngineConnectionError({
        code: "authentication",
        method: "session/resume",
        rpcCode: -32000,
      }),
    )
    .mockResolvedValueOnce(undefined);
  await expect(prepareExternalEngineSession(runtime, createRootTraceContext())).rejects.toThrow();
  expect(runtime.engineConfigError).toEqual({
    code: "authentication",
    method: "session/resume",
    rpcCode: -32000,
  });
  await prepareExternalEngineSession(runtime, createRootTraceContext());
  expect(runtime.engineConfigState).toBe("ready");
  expect(runtime.engineConfigError).toBeUndefined();
  expect(events.every((event) => event.type === SessionEventType.ExternalEngineConfigUpdated)).toBe(
    true,
  );
  expect(runtime.engineConfigOptions).toEqual([]);
});
