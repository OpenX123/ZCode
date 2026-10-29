import { describe, expect, test, vi } from "vitest";
import {
  createSessionId,
  SessionEventType,
  ExternalEngineConnectionError,
  type ExternalEnginePort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

describe("外部引擎使用既有 turn 生命周期", () => {
  test.each(["claude-code", "codex"] as const)(
    "%s 连续轮不会调用Provider、Context、Hook或MCP",
    async (engine) => {
      const sessionId = createSessionId();
      const eventStore = createTestSessionEventStore();
      const store = createRecordingSubagentSessionStore();
      const modelFactory = vi.fn(() => {
        throw new Error("Provider must not run");
      });
      const context = vi.fn(() => {
        throw new Error("Context must not run");
      });
      const hook = vi.fn();
      const mcp = vi.fn();
      const calls: string[] = [];
      const externalEnginePort: ExternalEnginePort = {
        async prepareSession() {},
        async runTurn(input) {
          calls.push(
            input.prompt.map((block) => (block.type === "text" ? block.text : "image")).join(""),
          );
          await input.onSession("engine-session");
          await input.onConfigOptions([
            {
              id: "mode",
              name: "Mode",
              currentValue: "safe",
              options: [{ value: "safe", name: "Safe" }],
            },
          ]);
          await input.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "engine response" },
          });
          return { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 2 } };
        },
        setConfigOption: vi.fn(),
        closeSession: vi.fn(),
      };
      const runtime = new AgentRuntime(
        sessionId,
        { engine, workingDirectory: "/workspace", titleGeneration: { enabled: true } },
        {
          eventStore,
          sessionStore: store,
          modelFactory,
          externalEnginePort,
          contextSourcePort: { resolveContextSources: context } as never,
          hookRunner: { run: hook },
          mcpPort: { connect: mcp } as never,
        },
      );
      expect(await runtime.executeTurn("first")).toMatchObject({ response: "engine response" });
      expect(await runtime.executeTurn("/compact")).toMatchObject({ response: "engine response" });
      expect(calls).toEqual(["first", "/compact"]);
      expect(modelFactory).not.toHaveBeenCalled();
      expect(context).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(mcp).not.toHaveBeenCalled();
      expect(runtime.getSessionEngine()).toBe(engine);
      expect(runtime.getEngineConfigOptions()).toHaveLength(1);
      const lifecycle = (await eventStore.getEvents(sessionId)).filter((event) =>
        [
          SessionEventType.TurnStarted,
          SessionEventType.TurnComplete,
          SessionEventType.TurnError,
        ].includes(event.type as never),
      );
      expect(lifecycle.map((event) => event.type)).toEqual([
        SessionEventType.TurnStarted,
        SessionEventType.TurnComplete,
        SessionEventType.TurnStarted,
        SessionEventType.TurnComplete,
      ]);
      const messages = await store.messages({ sessionID: sessionId });
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(2);
      expect(
        messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "engine response"),
        ),
      ).toBe(true);
      await runtime.closeBrowserSession();
      expect(externalEnginePort.closeSession).toHaveBeenCalledWith(sessionId);
    },
  );
});

test.each(["not_ready", "transport", "timeout", "protocol"] as const)(
  "配置中的 %s 故障撤销 ready，保留选择并通过既有入口恢复",
  async (code) => {
    const sessionId = createSessionId();
    const eventStore = createTestSessionEventStore();
    const options = [
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      },
    ];
    const prepareSession = vi.fn<ExternalEnginePort["prepareSession"]>(async (input) => {
      await input.onConfigOptions(options);
    });
    const runTurn = vi.fn<ExternalEnginePort["runTurn"]>();
    const runtime = new AgentRuntime(
      sessionId,
      { engine: "codex", externalSessionId: "original-session", workingDirectory: "/workspace" },
      {
        eventStore,
        externalEnginePort: {
          prepareSession,
          runTurn,
          setConfigOption: vi.fn().mockRejectedValue(new ExternalEngineConnectionError({ code })),
          closeSession: vi.fn(),
        },
      },
    );
    await runtime.prepareExternalEngineSession();
    await expect(runtime.setEngineConfigOption("reasoning_effort", "high")).rejects.toThrow();
    expect(runtime.getEngineConfigState()).toBe("error");
    expect(runtime.getEngineConfigError()).toEqual({ code });
    expect(runtime.getEngineConfigOptions()).toEqual(options);
    await runtime.prepareExternalEngineSession();
    expect(runtime.getEngineConfigState()).toBe("ready");
    expect(runtime.getEngineConfigError()).toBeUndefined();
    expect(prepareSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalSessionId: "original-session",
        configValues: [{ id: "reasoning_effort", value: "high" }],
      }),
    );
    expect(runTurn).not.toHaveBeenCalled();
    await runtime.closeBrowserSession();
  },
);

test("外部引擎busy时拒绝直接guide并把admission guide归一到普通队列", async () => {
  const sessionId = createSessionId();
  const eventStore = createTestSessionEventStore();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runtime = new AgentRuntime(
    sessionId,
    { engine: "codex", workingDirectory: "/workspace" },
    {
      eventStore,
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: () => {
        throw new Error("Provider must not run");
      },
      externalEnginePort: {
        async prepareSession() {},
        async runTurn() {
          started();
          await released;
          return { stopReason: "end_turn" };
        },
        async setConfigOption() {
          return [];
        },
        async closeSession() {},
      },
    },
  );
  const first = runtime.executeTurn("first");
  await ready;
  expect(await runtime.steerTurn({ delivery: "guide", input: "direct guide" })).toMatchObject({
    kind: "rejected",
    reason: "turn_not_steerable",
  });
  expect(
    await runtime.admitPrompt("next", undefined, {
      queueDelivery: "guide",
      inputId: "next-command",
    }),
  ).toMatchObject({ kind: "queued" });
  const queued = (await eventStore.getEvents(sessionId)).find(
    (event) => event.type === SessionEventType.TurnSteerQueued,
  );
  expect(queued?.payload).toMatchObject({
    delivery: "queue",
    input: "next",
    inputId: "next-command",
  });
  finish();
  await first;
  await runtime.closeBrowserSession();
});
