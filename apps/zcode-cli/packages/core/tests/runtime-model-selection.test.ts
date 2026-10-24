import { describe, expect, it, vi } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import {
  CoreErrorType,
  ModelErrorCode,
  ModelProtocolError,
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime model selection event", () => {
  it("首轮只按 admitted Active Model 构造一次 Context", async () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-first-turn-single-context-build"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const internalRuntime = runtime as typeof runtime & {
      createContextBuilderFromSnapshot: (...args: unknown[]) => unknown;
    };
    const createContextBuilderFromSnapshot =
      internalRuntime.createContextBuilderFromSnapshot.bind(internalRuntime);
    let contextBuildCount = 0;
    internalRuntime.createContextBuilderFromSnapshot = (...args: unknown[]) => {
      contextBuildCount++;
      return createContextBuilderFromSnapshot(...args);
    };

    await runtime.executeTurn("first turn");
    expect(contextBuildCount).toBe(1);

    await runtime.executeTurn("second turn");
    expect(contextBuildCount).toBe(2);
  });

  it("uses the admitted Active Model for both Context and the provider request", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-active-model-context"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("switch now", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "switch-command",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(requests[0]?.text).toContain("provider-b/model-b");
    expect(requests[0]?.text).not.toContain("provider-a/model-a");
  });

  it("uses an execution-scoped Active Model in Context without changing Session Selection", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    const sessionSelection = createTestModelSelection("provider-a/model-a");
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-execution-model-context"),
      {
        modelSelection: sessionSelection,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("idle task", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "idle-command",
      },
      modelExecution: { selectionScope: "execution" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
    });
    expect(requests[0]?.text).toContain("account:zai-offpeak-idle-plan/GLM-5.2");
    expect(requests[0]?.text).not.toContain("provider-a/model-a");
    expect(runtime.getSessionModelSelection()).toEqual(sessionSelection);
  });

  it("applies a Session Selection change during an active turn only to the next Active Model", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    let runtime: ReturnType<typeof createTestAgentRuntime>;
    runtime = createTestAgentRuntime(
      createSessionId("runtime-active-turn-selection-change"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            if (requests.length === 1) {
              runtime.setSessionModelSelection({
                providerId: "provider-b",
                modelId: "model-b",
                options: { reasoningLevel: "high" },
              });
            }
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ providerId: "provider-a", modelId: "model-a" });
    expect(requests[0]?.text).toContain("provider-a/model-a");
    expect(requests[0]?.text).not.toContain("provider-b/model-b");
    expect(requests[1]).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(requests[1]?.text).toContain("provider-b/model-b");
    expect(requests[1]?.text).not.toContain("provider-a/model-a");
  });

  it("uses structured ModelSelection as the current Session model fact", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-structured-session-model-selection"),
      {
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: {
            reasoningLevel: "high",
          },
        },
      },
      { eventStore: createTestSessionEventStore() },
    );

    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: {
        reasoningLevel: "high",
      },
    });

    const nextSelection = {
      providerId: "provider-b",
      modelId: "model-b",
      options: {
        reasoningLevel: "low",
      },
    };
    runtime.setSessionModelSelection(nextSelection);
    nextSelection.options.reasoningLevel = "mutated-outside-runtime";

    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: {
        reasoningLevel: "low",
      },
    });
  });

  it("publishes the Active Model context window with ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-context-window");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({ properties: { contextWindow: 1_000_000 } }),
      },
    );

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("deepseek"),
        modelId: createModelId("deepseek-v4-flash"),
      },
      supportedThoughtLevels: ["max", "high", "nothink"],
      traceContext: { traceId: "trace-runtime-model-selection" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      contextWindow: 1_000_000,
      modelSelection: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
      },
      supportedThoughtLevels: ["max", "high", "nothink"],
    });
  });

  it("preserves the registry fallback origin in ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-registry-fallback");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("provider-b"),
        modelId: createModelId("model-b"),
      },
      previousModelSelection: {
        providerId: createModelProviderId("provider-a"),
        modelId: createModelId("model-a"),
      },
      origin: "registryFallback",
      traceContext: { traceId: "trace-runtime-model-selection-fallback" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      origin: "registryFallback",
      previousModelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
      },
    });
  });

  it("uses the execution-scoped Selection for foreground children without applying profile reasoning", async () => {
    const sessionId = createSessionId("runtime-turn-model-foreground-subagents");
    const eventStore = createTestSessionEventStore();
    const sessionModel = createTestModelSelection("user-provider/user-model");
    const childExecutions: Array<Record<string, unknown>> = [];
    const mainRequests: Array<Record<string, unknown>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection(sessionModel),
        subagents: {
          profiles: [
            {
              description: "Search source code",
              modelSelection: {
                providerId: "custom-provider",
                modelId: "custom-code-model",
                options: { reasoningLevel: "high" },
              },
              name: "Code Search",
              source: "user",
              systemPrompt: "Search code.",
              tools: ["Read"],
            },
          ],
        },
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          maxOutputTokens: (input) =>
            input.selection.providerId === "account:zai-offpeak-idle-plan" ? 16_000 : 32_000,
          async generateText(request, observation) {
            const metadata = observation.invocationContext?.metadata as
              | { querySource?: string; turnNumber?: number }
              | undefined;
            const capturedRequest = {
              maxOutputTokens: request.options?.maxOutputTokens,
              model: observation.model,
            };
            if (metadata?.querySource === "subagent") {
              childExecutions.push(capturedRequest);
              return {
                finishReason: "stop",
                model: observation.model,
                text: "child done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            mainRequests.push(capturedRequest);
            if (metadata?.turnNumber === 0 && mainRequests.length === 1) {
              return {
                finishReason: "tool-calls",
                model: observation.model,
                text: "",
                toolCalls: [
                  {
                    id: "call_explore",
                    name: "Agent",
                    input: {
                      description: "Explore source",
                      prompt: "Explore the source.",
                      subagent_type: "Explore",
                    },
                  },
                  {
                    id: "call_code_search",
                    name: "Agent",
                    input: {
                      description: "Search source",
                      prompt: "Search the source.",
                      subagent_type: "Code Search",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (metadata?.turnNumber === 1 && mainRequests.length === 3) {
              return {
                finishReason: "tool-calls",
                model: observation.model,
                text: "",
                toolCalls: [
                  {
                    id: "call_code_search_ordinary",
                    name: "Agent",
                    input: {
                      description: "Search source with profile settings",
                      prompt: "Search the source with the configured profile.",
                      subagent_type: "Code Search",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              model: observation.model,
              text: "turn done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("run foreground children", undefined, {
      intent: {
        sourceCommandId: "idle-command",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
      },
      modelExecution: {
        selectionScope: "execution",
        subagents: { foregroundModel: "submission", background: "deny" },
      },
    });
    await runtime.executeTurn("ordinary prompt");

    expect(childExecutions).toHaveLength(3);
    expect(childExecutions.slice(0, 2).map((execution) => execution.model)).toEqual([
      expect.objectContaining({
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
      }),
      expect.objectContaining({
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
      }),
    ]);
    expect(
      childExecutions
        .slice(0, 2)
        .map(
          (execution) =>
            (execution.model as { options?: { reasoningLevel?: string } }).options?.reasoningLevel,
        ),
    ).toEqual(["high", "high"]);
    expect(childExecutions.slice(0, 2).map((execution) => execution.maxOutputTokens)).toEqual([
      16_000, 16_000,
    ]);
    expect(childExecutions[2]?.model).toEqual(
      expect.objectContaining({
        providerId: "custom-provider",
        modelId: "custom-code-model",
      }),
    );
    expect(childExecutions[2]?.model).toEqual(
      expect.objectContaining({ options: expect.objectContaining({ reasoningLevel: "high" }) }),
    );
    expect(mainRequests).toHaveLength(4);
    expect(mainRequests.at(-1)?.model).toEqual(
      expect.objectContaining({
        providerId: "user-provider",
        modelId: "user-model",
      }),
    );
    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: String(sessionModel.providerId),
      modelId: String(sessionModel.modelId),
    });
  });

  it.each(["failure", "cancel"] as const)(
    "does not retain an execution-scoped Selection after %s",
    async (outcome) => {
      const sessionId = createSessionId(`runtime-turn-model-cleanup-${outcome}`);
      const abortController = new AbortController();
      const requests: Array<Record<string, unknown>> = [];
      let failFirstRequest = true;
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          modelSelection: createTestModelSelection(
            createTestModelSelection("user-provider/user-model"),
          ),
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace/project",
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(request, observation) {
              requests.push({
                model: observation.model,
                request,
              });
              if (failFirstRequest) {
                failFirstRequest = false;
                if (outcome === "cancel") {
                  abortController.abort(new Error("user cancelled idle turn"));
                }
                throw new Error(`${outcome} idle turn`);
              }
              return {
                finishReason: "stop",
                model: observation.model,
                text: "ordinary turn done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never),
        },
      );

      await expect(
        runtime.executeTurn("idle turn", undefined, {
          abortSignal: abortController.signal,
          intent: {
            sourceCommandId: `idle-${outcome}`,
            kind: "sendText",
            requestedDelivery: "start-now",
            modelSelection: {
              providerId: "account:zai-offpeak-idle-plan",
              modelId: "GLM-5.2",
            },
          },
          modelExecution: {
            selectionScope: "execution",
          },
        }),
      ).rejects.toMatchObject({
        type: outcome === "cancel" ? CoreErrorType.TurnCancelled : CoreErrorType.UnknownError,
      });

      await runtime.executeTurn("ordinary prompt");

      expect(requests).toHaveLength(2);
      expect(requests[0]?.model).toEqual(
        expect.objectContaining({
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
        }),
      );
      expect(requests[1]?.model).toEqual(
        expect.objectContaining({ providerId: "user-provider", modelId: "user-model" }),
      );
    },
  );

  it.each([ModelErrorCode.ProviderNotFound, ModelErrorCode.ModelNotFound])(
    "旧套餐模型失效时保留原始错误且不回退其他 Provider（%s）",
    async (code) => {
      const sessionId = createSessionId(`runtime-execution-selection-creation-${code}`);
      const eventStore = createTestSessionEventStore();
      const highspeedProviderId = "account:bigmodel-highspeed-card";
      const created: Array<{ providerId: string; modelId: string }> = [];
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          modelSelection: createTestModelSelection("user-provider/user-model"),
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace/project",
        },
        {
          eventStore,
          modelFactory: createTestModelFactory({
            onCreate(input) {
              created.push(input.selection);
              if (input.selection.providerId === highspeedProviderId) {
                throw new ModelProtocolError(code, "Highspeed selection is unavailable");
              }
            },
            async generateText(_request, observation) {
              return {
                finishReason: "stop",
                model: observation.model,
                text: "continued with the original model",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              };
            },
          }),
        },
      );

      const turn = runtime.executeTurn("continue before request", undefined, {
        inputId: `command-creation-${code}`,
        intent: {
          sourceCommandId: `command-creation-${code}`,
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
        },
        modelExecution: {
          selectionScope: "execution",
          selectionFallback: {
            providerId: highspeedProviderId,
            rules: [{ reason: "highspeed_card_expired", providerErrorCode: "3402" }],
            target: { providerId: "user-provider", modelId: "user-model" },
          },
        } as never,
      });

      await expect(turn).rejects.toMatchObject({
        cause: expect.objectContaining({ code }),
      });
      expect(created).toEqual([{ providerId: highspeedProviderId, modelId: "GLM-5.3" }]);
      expect(runtime.getSessionModelSelection()).toEqual({
        providerId: "user-provider",
        modelId: "user-model",
      });
      const events = await eventStore.getEvents(sessionId);
      expect(
        events.filter((event) => event.type === SessionEventType.TurnExecutionModelFallback),
      ).toHaveLength(0);
      expect(events.some((event) => event.type === SessionEventType.TurnStarted)).toBe(true);
      expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(true);
    },
  );

  it("does not fall back when local streaming event persistence fails", async () => {
    // Bug 根因：selectionFallback 的无错误码规则曾把 stream 消费期间的本地落库异常也当成 provider 失败，
    // 不仅掩埋真实存储故障，还会错误地向原模型再发一次请求。
    const sessionId = createSessionId("runtime-execution-selection-local-persistence-failure");
    const eventStore = createTestSessionEventStore();
    const appendEvent = eventStore.append.bind(eventStore);
    eventStore.append = vi.fn(async (event) => {
      if (event.type === SessionEventType.ModelStreaming) {
        throw new Error("event store append failed");
      }
      return appendEvent(event);
    });
    const providerId = "personal:test-provider";
    const streamedProviders: string[] = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        modelStreaming: "on",
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async *streamText(_request, observation) {
            streamedProviders.push(String(observation.model.providerId));
            yield { id: "text-1", type: "text_start" };
            yield { id: "text-1", text: "provider output", type: "text_delta" };
            yield { id: "text-1", type: "text_end" };
            yield {
              finishReason: "stop",
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        }),
      },
    );

    const failure = (await runtime
      .executeTurn("persist this stream", undefined, {
        inputId: "command-local-persistence-failure",
        intent: {
          sourceCommandId: "command-local-persistence-failure",
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: providerId, modelId: "GLM-5.3" },
        },
        modelExecution: {
          selectionScope: "execution",
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as (Error & { cause?: unknown }) | undefined;

    expect(failure).toBeInstanceOf(Error);
    const causeMessage = failure?.cause instanceof Error ? failure.cause.message : undefined;
    expect([failure?.message, causeMessage]).toContain("event store append failed");
    expect(streamedProviders).toEqual([providerId]);
    const fallbackEvents = (await eventStore.getEvents(sessionId)).filter(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvents).toHaveLength(0);
  });

  it("preserves an explicit source-less model boundary in ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-source-less-boundary");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("child-provider"),
        modelId: createModelId("child-model"),
      },
      previousModelSelection: null,
      traceContext: { traceId: "trace-runtime-model-selection-source-less" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      previousModelSelection: null,
      modelSelection: {
        providerId: "child-provider",
        modelId: "child-model",
      },
    });
  });
});
