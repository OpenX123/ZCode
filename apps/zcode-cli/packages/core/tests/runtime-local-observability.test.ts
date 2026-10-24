import { describe, expect, it, vi } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime 本地运行观测", () => {
  it("无遥测端口时 Auto Compact 仍保留本地占用、窗口和阈值日志", async () => {
    const info = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info,
      warn: vi.fn(),
    };
    let mainRequestCount = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-auto-compact-local"),
      {
        maxOutputTokens: 64_000,
        modelContextBudgetStrategy: "preflight-v1",
        modelStreaming: "off",
      },
      {
        eventStore: createTestSessionEventStore(),
        logger,
        modelFactory: createTestModelFactory({
          properties: { contextWindow: 128_000 },
          async generateText(_request, observation) {
            if (observation.invocationContext?.modelCall?.operation === "context_compaction") {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "<summary>Local compact summary.</summary>",
                toolCalls: [],
                usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
              };
            }
            mainRequestCount += 1;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `response-${mainRequestCount}`,
              toolCalls: [],
              usage:
                mainRequestCount === 1
                  ? { inputTokens: 94_001, outputTokens: 1, totalTokens: 94_002 }
                  : { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("seed provider usage");
    await runtime.executeTurn("trigger auto compact");

    const decisionLog = info.mock.calls
      .map((call) => call[1])
      .find((context) => context?.event === "compact.auto.started");
    expect(decisionLog).toMatchObject({
      contextWindow: 128_000,
      threshold: 94_000,
      tokenSource: "provider_usage",
    });
    expect(decisionLog.tokenCount).toBeGreaterThanOrEqual(94_001);
  });

  it.each(["subagent_child", "workflow_child", "nested_workflow_child"] as const)(
    "%s 保留模型请求归因与真实执行结果",
    async (taskType) => {
      const modelCalls: unknown[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId(`runtime-local-${taskType}`),
        {
          modelStreaming: "off",
          parentSessionId: createSessionId("runtime-local-parent"),
          taskType,
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              modelCalls.push(observation.invocationContext?.modelCall);
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "child done",
                toolCalls: [],
                usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              };
            },
          } as never),
        },
      );
      const result = await runtime.executeTurn("child prompt");
      expect(result.response).toBe("child done");
      expect(modelCalls).toEqual([
        expect.objectContaining({
          actorKind: taskType === "subagent_child" ? "subagent" : "workflow_child",
          operation: "agent_step",
        }),
      ]);
    },
  );
});
