import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { AgentRuntime, type AgentRuntimeDeps } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRuntime(
  sessionKey: string,
  generateText: (input: unknown) => Promise<unknown>,
  runtimeActivitySink?: (state: { busy: boolean; closed: boolean }) => void,
  extraDeps?: Partial<AgentRuntimeDeps>,
) {
  return new AgentRuntime(
    createSessionId(sessionKey),
    {
      mode: "build",
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({ generateText: generateText as never }),
      runtimeActivitySink,
      ...extraDeps,
    },
  );
}

function admissionOptions(inputId: string) {
  return {
    inputId,
    queryId: inputId,
    traceContext: {
      queryId: inputId,
      sessionId: createSessionId("prompt-admission-test"),
      traceId: `trace-${inputId}`,
    },
  } as never;
}

describe("AgentRuntime prompt admission", () => {
  it("keeps shutdown activity until the actual command owner releases", async () => {
    const modelEntered = deferred<void>();
    const model = deferred<void>();
    const closed = deferred<void>();
    const states: Array<{ busy: boolean; closed: boolean }> = [];
    const runtime = createRuntime(
      "activity-shutdown",
      async () => {
        modelEntered.resolve();
        await model.promise;
        return {
          finishReason: "stop",
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      (state) => {
        states.push(state);
        if (state.closed) closed.resolve();
      },
    );
    const admission = await runtime.admitPrompt(
      "work",
      undefined,
      admissionOptions("activity-shutdown"),
    );
    if (admission.kind !== "started") throw new Error("not admitted");
    try {
      await modelEntered.promise;
      runtime.beginShutdown();
      expect(states.map(({ busy, closed: done }) => ({ busy, closed: done }))).toEqual([
        { busy: false, closed: false },
        { busy: true, closed: false },
      ]);
      model.resolve();
      await admission.completion;
      await closed.promise;
      expect(states.at(-1)).toMatchObject({ busy: false, closed: true });
    } finally {
      model.resolve();
      await admission.completion;
    }
  });

  it("keeps activity through terminal browser cleanup and the next queued runtime command", async () => {
    const cleanupEntered = deferred<void>();
    const cleanup = deferred<void>();
    const secondEntered = deferred<void>();
    const secondModel = deferred<void>();
    const idle = deferred<void>();
    const activity: boolean[] = [];
    let calls = 0;
    let cleaned = 0;
    const runtime = createRuntime(
      "activity-cleanup",
      async () => {
        calls += 1;
        if (calls === 2) {
          secondEntered.resolve();
          await secondModel.promise;
        }
        return {
          finishReason: "stop",
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      (state) => {
        activity.push(state.busy);
        if (activity.includes(true) && !state.busy) idle.resolve();
      },
      {
        browserControlPort: {
          turnEnded: async () => {
            if (++cleaned === 1) {
              cleanupEntered.resolve();
              await cleanup.promise;
            }
          },
        } as AgentRuntimeDeps["browserControlPort"],
      },
    );
    const first = await runtime.admitPrompt("one", undefined, admissionOptions("activity-one"));
    if (first.kind !== "started") throw new Error("not admitted");
    await cleanupEntered.promise;
    expect(runtime.getActiveTurnInfo()).toBeUndefined();
    expect(activity).toEqual([false, true]);
    const second = runtime.executeTurn("two", undefined, admissionOptions("activity-two"));
    cleanup.resolve();
    await secondEntered.promise;
    expect(activity).toEqual([false, true]);
    secondModel.resolve();
    await Promise.all([first.completion, second]);
    await idle.promise;
    expect(activity).toEqual([false, true, false]);
  });

  it("exports admission activity before ACK and keeps command ownership through terminal cleanup", async () => {
    const model = deferred<unknown>();
    const idle = deferred<void>();
    const activity: boolean[] = [];
    const runtime = createRuntime(
      "activity-admission",
      async () => {
        await model.promise;
        return {
          finishReason: "stop",
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      (state) => {
        activity.push(state.busy);
        if (activity.includes(true) && !state.busy) idle.resolve();
      },
    );
    let admission: Awaited<ReturnType<AgentRuntime["admitPrompt"]>> | undefined;
    try {
      admission = await runtime.admitPrompt("first", undefined, admissionOptions("activity-first"));
      expect(admission.kind).toBe("started");
      expect(activity).toEqual([false, true]);
      model.resolve(undefined);
      if (admission.kind === "started") await admission.completion;
      await idle.promise;
      expect(activity).toEqual([false, true, false]);
    } finally {
      model.resolve(undefined);
      if (admission?.kind === "started") await admission.completion;
    }
  });

  it("does not treat an idle requireQueue input as activity and closes the actual instance", async () => {
    const activity: Array<{ busy: boolean; closed: boolean }> = [];
    const runtime = createRuntime(
      "activity-held",
      async () => {
        throw new Error("must remain queued");
      },
      (state) => activity.push(state),
    );
    expect(
      (
        await runtime.admitPrompt("held", undefined, {
          ...admissionOptions("activity-held"),
          requireQueue: true,
        })
      ).kind,
    ).toBe("queued");
    expect(activity).toMatchObject([{ busy: false, closed: false }]);
    runtime.beginShutdown();
    expect(activity).toMatchObject([
      { busy: false, closed: false },
      { busy: false, closed: true },
    ]);
  });

  it("keeps requireQueue input queued even when the runtime is idle", async () => {
    let modelCalls = 0;
    const runtime = createRuntime("prompt-admission-require-queue", async () => {
      modelCalls += 1;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const admission = await runtime.admitPrompt("future turn", undefined, {
      ...admissionOptions("require-queue"),
      requireQueue: true,
    });

    expect(admission.kind).toBe("queued");
    expect(modelCalls).toBe(0);
  });

  it("reserves before the first turn reaches TurnStarted, so the second prompt is queued", async () => {
    const modelGate = deferred<unknown>();
    let modelCalls = 0;
    const runtime = createRuntime("prompt-admission-reservation", async () => {
      modelCalls += 1;
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("first"));
    const second = await runtime.admitPrompt("second", undefined, admissionOptions("second"));

    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    if (second.kind !== "queued") throw new Error("second prompt was not queued");
    expect(modelCalls).toBeLessThanOrEqual(1);

    modelGate.resolve(undefined);
    await first.completion;
  });

  it("queues against activeTurn after the reservation is promoted", async () => {
    const modelGate = deferred<unknown>();
    const runtime = createRuntime("prompt-admission-active", async () => {
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("active-first"));
    for (let attempt = 0; attempt < 100 && !runtime.getActiveTurnInfo(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runtime.getActiveTurnInfo()).toBeDefined();

    const second = await runtime.admitPrompt(
      "second",
      undefined,
      admissionOptions("active-second"),
    );
    expect(second.kind).toBe("queued");

    modelGate.resolve(undefined);
    if (first.kind === "started") await first.completion;
  });

  it("keeps the queued Submission Selection after the Session Selection changes", async () => {
    const firstRequestGate = deferred<unknown>();
    const requests: Array<{ providerId: string; reasoningLevel: unknown; context: string }> = [];
    const runtime = new AgentRuntime(
      createSessionId("prompt-admission-frozen-submission-selection"),
      {
        mode: "build",
        modelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              providerId: String(observation.model.providerId),
              reasoningLevel: observation.model.options.reasoningLevel,
              context: JSON.stringify(request.messages),
            });
            await firstRequestGate.promise;
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("frozen-first"));
    const second = await runtime.admitPrompt("second", undefined, {
      ...admissionOptions("frozen-second"),
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "low" },
        },
        requestedDelivery: "queue",
        sourceCommandId: "frozen-second",
      },
    });
    expect(second.kind).toBe("queued");

    runtime.setSessionModelSelection({
      providerId: "provider-c",
      modelId: "model-c",
      options: { reasoningLevel: "high" },
    });

    const queuedInput = (await runtime.getProjection()).pendingSteerInputs.find(
      (input) => input.pendingInputId === second.pendingInputId,
    );
    expect(queuedInput?.intent?.modelSelection).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "low" },
    });
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "provider-c",
      modelId: "model-c",
    });

    firstRequestGate.resolve(undefined);
    if (first.kind === "started") await first.completion;
    // 不只断言队列里的 DTO：按消费者接到的冻结 intent 开新 Turn，验证正式 Model 和 Context。
    await runtime.executeTurn("second", undefined, { intent: queuedInput?.intent });
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-b", reasoningLevel: "low" });
    expect(requests.at(-1)?.context).toContain("provider-b/model-b");
    expect(requests.at(-1)?.context).not.toContain("provider-c/model-c");
  });

  it("treats a runtime command drain as busy even without an active turn", async () => {
    const runtime = createRuntime("prompt-admission-drain", async () => ({
      finishReason: "stop",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const internal = runtime as unknown as { runtimeCommandDrainActive: boolean };
    internal.runtimeCommandDrainActive = true;

    const admission = await runtime.admitPrompt(
      "during drain",
      undefined,
      admissionOptions("during-drain"),
    );

    expect(admission.kind).toBe("queued");
    internal.runtimeCommandDrainActive = false;
  });

  it("keeps two session runtimes independent while both foreground turns are running", async () => {
    const modelGates = [deferred<unknown>(), deferred<unknown>()];
    let modelCalls = 0;
    const createGatedRuntime = (key: string, gate: ReturnType<typeof deferred<unknown>>) =>
      createRuntime(key, async () => {
        modelCalls += 1;
        await gate.promise;
        return {
          finishReason: "stop",
          text: key,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      });
    const firstRuntime = createGatedRuntime("prompt-admission-a", modelGates[0]!);
    const secondRuntime = createGatedRuntime("prompt-admission-b", modelGates[1]!);

    const first = await firstRuntime.admitPrompt("a", undefined, admissionOptions("a"));
    const second = await secondRuntime.admitPrompt("b", undefined, admissionOptions("b"));

    if (first.kind !== "started" || second.kind !== "started") {
      throw new Error("both sessions must be admitted independently");
    }
    for (let attempt = 0; attempt < 100 && modelCalls < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(modelCalls).toBe(2);

    modelGates[0]!.resolve(undefined);
    modelGates[1]!.resolve(undefined);
    await Promise.all([first.completion, second.completion]);
  });
});

it("renders a human guide through real admission and keeps the ongoing turn", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const requests: unknown[] = [];
  const runtime = createRuntime("human-guide-presentation", async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      finishReason: "stop",
      text: requests.length === 1 ? "working on A" : "continued A",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  });
  const first = await runtime.admitPrompt("task A");
  await entered.promise;
  const guide = await runtime.admitPrompt("short B", undefined, { queueDelivery: "guide" });
  expect(guide.kind).toBe("queued");
  release.resolve();
  if (first.kind !== "started") throw new Error("first not started");
  await first.completion;
  expect(requests).toHaveLength(2);
  const messages = (requests[1] as { messages: Array<{ role: string; content: unknown }> })
    .messages;
  const incoming = messages.find(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes("The user sent a new message while you were working:"),
  );
  expect(incoming).toMatchObject({
    role: "user",
    content:
      "<system-reminder>\nThe user sent a new message while you were working:\nshort B\n\nThis is how ZCode surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>",
  });
});
