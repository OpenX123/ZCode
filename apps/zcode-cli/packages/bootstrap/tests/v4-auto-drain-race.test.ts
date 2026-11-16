import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createTraceId,
  createTurnId,
  type ProjectId,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeRuntimeActivitySnapshotSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import {
  V4_METHODS,
  conversationTopic,
  conversationTopicFrameSchema,
  reassembleTopicWireFrames,
  routedTopicWireFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import type { ZCodeProtocolSessionRecord } from "../src/zcode-protocol/server-types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = {
  workspacePath: "/workspace/v4-auto-drain-race",
  workspaceKey: "/workspace/v4-auto-drain-race",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function createActivityHarness() {
  let options!: ZCodeAppOptions;
  let eventSink: ((event: SessionEvent) => void) | undefined;
  let sequence = 0;
  let sessionId = "";
  let instanceId = 1;
  let foreground: string | undefined;
  let promotionLease = false;
  const completion = deferred<unknown>();
  const promotedCompletion = deferred<unknown>();
  const counts: number[] = [];
  const readTarget = vi.fn().mockResolvedValue(null);
  const readTodos = vi.fn().mockResolvedValue([]);
  const emit = (
    type: SessionEvent["type"],
    payload: unknown,
    rawSequence = ++sequence,
    eventId = `activity-event-${rawSequence}`,
  ) => {
    sequence = Math.max(sequence, rawSequence);
    const event = {
      id: eventId,
      sequenceNumber: rawSequence,
      sessionId,
      type,
      payload,
      traceId: createTraceId("activity-trace"),
      timestamp: new Date(1700000000000 + rawSequence),
    } as SessionEvent;
    eventSink?.(event);
    return event;
  };
  const core = (busy: boolean, closed = false, generation = instanceId) => {
    foreground = busy ? "actual-command" : undefined;
    options.runtimeActivitySink?.({
      sessionId,
      instanceId: generation,
      busy: busy || promotionLease,
      closed,
    });
  };
  const sendInput = vi.fn().mockImplementation(async () => {
    core(true);
    return {
      kind: "started_turn",
      turnId: `turn-${sendInput.mock.calls.length}`,
      completion:
        sendInput.mock.calls.length === 1 ? completion.promise : promotedCompletion.promise,
    };
  });
  const reserveQueueItem = vi.fn().mockResolvedValue(true);
  const removeQueueItem = vi.fn().mockImplementation(async (queueItemId: string) => {
    emit(SessionEventType.TurnSteerDiscarded, {
      pendingInputIds: [queueItemId],
      reason: "promoted",
    });
    return true;
  });
  const setQueueAutoDrain = vi.fn().mockImplementation(async (autoDrain: boolean) => {
    emit(SessionEventType.QueueAutoDrainChanged, { autoDrain });
  });
  const acquireForegroundPromotionLease = vi.fn().mockImplementation(({ leaseId }) => {
    promotionLease = true;
    options.runtimeActivitySink?.({ sessionId, instanceId, busy: true, closed: false });
    return { kind: "acquired", leaseId };
  });
  const server = new ZCodeProtocolAgentServer({
    cwd: workspace.workspacePath,
    createZCodeApp: (input: ZCodeAppOptions) => {
      options = input;
      sessionId = String(input.sessionId);
      core(false);
      const app = createFakeApp(input);
      return {
        ...app,
        sendInput,
        readTarget,
        readTodos,
        reserveQueueItem,
        removeQueueItem,
        markQueueItemPromoting: vi.fn().mockResolvedValue(true),
        releaseQueueItemReservation: vi.fn().mockResolvedValue(true),
        setQueueAutoDrain,
        close: async () => core(false, true),
        runtime: {
          ...app.runtime,
          getActiveForegroundExecutionId: () => foreground,
          beginShutdown: () => core(false, true),
          acquireForegroundPromotionLease,
          releaseForegroundPromotionLease: () => {
            promotionLease = false;
            options.runtimeActivitySink?.({
              sessionId,
              instanceId,
              busy: foreground !== undefined,
              closed: false,
            });
            return true;
          },
          subscribeEvents: (sink) => {
            eventSink = sink.onSessionEvent;
            return () => {};
          },
        },
      } as ZCodeApp;
    },
  });
  // fake app 不提供反向偏好 RPC；创建沿既有 no-client 兼容路径，绑定仍早于任何业务输入。
  await requestResult(server, {
    id: "activity-create",
    method: zcodeProtocolMethods.sessionCreate,
    params: { workspace },
  });
  server.setNotificationSink((message) => {
    if (message.method !== "process/runtimeActivity") return;
    const snapshot = zcodeRuntimeActivitySnapshotSchema.parse(message.params);
    const count = snapshot.sessions.filter((state) => state.busy).length;
    if (counts.at(-1) !== count) counts.push(count);
  });
  emit(SessionEventType.SessionCreated, { contextWindow: 128000, mode: "build" });
  readTarget.mockClear();
  readTodos.mockClear();
  const command = async (
    type: string,
    payload: unknown,
    commandId = `activity-${type}-${Date.now()}`,
  ) => {
    let baseRevision = 0;
    if (type === "setAutoDrain") {
      const requestId = `${commandId}-snapshot`;
      await requestResult(server, {
        id: requestId,
        method: V4_METHODS.conversationSubscribe,
        params: {
          clientMode: "desktop-continuous",
          connectionId: "activity-read",
          topic: conversationTopic(sessionId),
        },
      });
      const initial = reassembleTopicWireFrames(
        server
          .takePostResponseMessages(requestId)
          .map((message) => routedTopicWireFrameSchema.parse(message.params)),
        conversationTopicFrameSchema,
      );
      if (initial.kind !== "complete" || initial.frame.payload.kind !== "snapshot")
        throw new Error("missing activity snapshot");
      baseRevision = initial.frame.payload.snapshot.revision;
    }
    const ack = await requestResult(server, {
      id: commandId,
      method: V4_METHODS.command,
      params: {
        baseRevision,
        clientId: "activity-client",
        commandId,
        issuedAt: 1,
        sessionId,
        type,
        payload,
      },
    });
    expect(ack).toMatchObject({ status: "accepted" });
    return ack;
  };
  const queue = (id = "queued-b", rawSequence?: number) =>
    emit(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: id,
        inputId: `source-${id}`,
        input: id,
        inputPreview: id,
        inputSize: id.length,
        delivery: "queue",
        targetTurnId: "turn-a",
        queueLength: 1,
        intent: {
          sourceCommandId: `source-${id}`,
          queueItemId: id,
          clientId: "activity-client",
          kind: "sendText",
          admissionSeq: sequence + 1,
          admittedAt: 1,
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
      },
      rawSequence,
    );
  return {
    server,
    counts,
    core,
    command,
    queue,
    emit,
    completion,
    promotedCompletion,
    readTarget,
    readTodos,
    sendInput,
    reserveQueueItem,
    removeQueueItem,
    setQueueAutoDrain,
    acquireForegroundPromotionLease,
    replaceInstance() {
      instanceId += 1;
      core(true);
    },
    async close() {
      completion.resolve({});
      promotedCompletion.resolve({});
      await server.shutdown();
      server.disposeProjections();
    },
  };
}

async function requestResult(
  server: ZCodeProtocolAgentServer,
  message: ZCodeProtocolMessage,
): Promise<unknown> {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function createRecordReplacementHarness() {
  const sessionId = "activity-real-record-replacement" as SessionId;
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const secondConstructed = deferred<void>();
  const registerSecond = deferred<void>();
  const snapshots: Array<ReturnType<typeof zcodeRuntimeActivitySnapshotSchema.parse>> = [];
  function createGeneration(options: ZCodeAppOptions, instanceId: number) {
    let eventSink: ((event: SessionEvent) => void) | undefined;
    let sequence = 0;
    let busy = false;
    const completion = deferred<unknown>();
    const core = (active: boolean, closed = false) => {
      busy = active;
      options.runtimeActivitySink?.({ sessionId, instanceId, busy, closed });
    };
    const emit = (type: SessionEvent["type"], payload: unknown) => {
      sequence += 1;
      eventSink?.({
        id: `record-${instanceId}-event-${sequence}`,
        sequenceNumber: sequence,
        sessionId,
        type,
        payload,
        traceId: createTraceId("record-replacement-trace"),
        timestamp: new Date(1700000000000 + sequence),
      } as SessionEvent);
    };
    const base = createFakeApp(options);
    const readTodos = vi.fn().mockResolvedValue([]);
    const readTarget = vi.fn().mockResolvedValue(null);
    const reserveQueueItem = vi.fn().mockResolvedValue(true);
    const sendInput = vi.fn().mockImplementation(async () => {
      core(true);
      return {
        kind: "started_turn",
        turnId: `record-turn-${instanceId}`,
        completion: completion.promise,
      };
    });
    const app = {
      ...base,
      readTodos,
      readTarget,
      reserveQueueItem,
      sendInput,
      close: async () => core(false, true),
      setQueueAutoDrain: async (autoDrain: boolean) =>
        emit(SessionEventType.QueueAutoDrainChanged, { autoDrain }),
      runtime: {
        ...base.runtime,
        beginShutdown: () => core(false, true),
        getActiveForegroundExecutionId: () => (busy ? `record-command-${instanceId}` : undefined),
        subscribeEvents: (sink: { onSessionEvent?: (event: SessionEvent) => void }) => {
          eventSink = sink.onSessionEvent;
          return () => {
            eventSink = undefined;
          };
        },
      },
    } as ZCodeApp;
    return {
      app,
      core,
      completion,
      emit,
      readTodos,
      readTarget,
      reserveQueueItem,
      sendInput,
      queue() {
        const queueItemId = `record-${instanceId}-queued`;
        emit(SessionEventType.TurnSteerQueued, {
          pendingInputId: queueItemId,
          inputId: `source-${queueItemId}`,
          input: "queued",
          inputPreview: "queued",
          inputSize: 6,
          delivery: "queue",
          targetTurnId: `record-turn-${instanceId}`,
          queueLength: 1,
          intent: {
            sourceCommandId: `source-${queueItemId}`,
            queueItemId,
            clientId: "replacement-client",
            kind: "sendText",
            admissionSeq: sequence + 1,
            admittedAt: 1,
            requestedDelivery: "queue",
            admittedDelivery: "queue",
          },
        });
      },
    };
  }
  const generations: Array<ReturnType<typeof createGeneration>> = [];
  const server = new ZCodeProtocolAgentServer({
    cwd: workspace.workspacePath,
    sessionStore: store,
    createZCodeApp: async (options: ZCodeAppOptions) => {
      const generation = createGeneration(options, generations.length + 1);
      generations.push(generation);
      generation.core(false);
      if (generations.length === 2) {
        secondConstructed.resolve();
        await registerSecond.promise;
      }
      return generation.app;
    },
  });
  server.setNotificationSink((message) => {
    if (message.method === "process/runtimeActivity")
      snapshots.push(zcodeRuntimeActivitySnapshotSchema.parse(message.params));
    if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences && "id" in message)
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false },
      });
  });
  await requestResult(server, {
    id: "record-create",
    method: zcodeProtocolMethods.sessionCreate,
    params: { sessionId, workspace },
  });
  await store.createSession({
    id: sessionId,
    projectID: "record-replacement-project" as ProjectId,
    directory: workspace.workspacePath,
    path: workspace.workspacePath,
    slug: "record-replacement",
    title: "record replacement",
    version: "test",
  });
  generations[0]!.emit(SessionEventType.SessionCreated, { contextWindow: 128000, mode: "build" });
  let commandSequence = 0;
  const record = () =>
    (
      server as unknown as { context: { sessions: Map<string, ZCodeProtocolSessionRecord> } }
    ).context.sessions.get(sessionId)!;
  return {
    generations,
    snapshots,
    record,
    secondConstructed,
    registerSecond,
    async command(type: "sendText" | "setAutoDrain") {
      const id = `replacement-command-${++commandSequence}`;
      let baseRevision = 0;
      if (type === "setAutoDrain") {
        const snapshotId = `${id}-snapshot`;
        await requestResult(server, {
          id: snapshotId,
          method: V4_METHODS.conversationSubscribe,
          params: {
            clientMode: "desktop-continuous",
            connectionId: "replacement-read",
            topic: conversationTopic(sessionId),
          },
        });
        const initial = reassembleTopicWireFrames(
          server
            .takePostResponseMessages(snapshotId)
            .map((message) => routedTopicWireFrameSchema.parse(message.params)),
          conversationTopicFrameSchema,
        );
        if (initial.kind !== "complete" || initial.frame.payload.kind !== "snapshot")
          throw new Error("missing replacement snapshot");
        baseRevision = initial.frame.payload.snapshot.revision;
      }
      const result = await requestResult(server, {
        id,
        method: V4_METHODS.command,
        params: {
          baseRevision,
          clientId: "replacement-client",
          commandId: id,
          issuedAt: 1,
          sessionId,
          type,
          payload: type === "sendText" ? { text: "work" } : { autoDrain: true },
        },
      });
      expect(result).toMatchObject({ status: "accepted" });
    },
    closeSession: () =>
      requestResult(server, {
        id: "record-close",
        method: zcodeProtocolMethods.sessionClose,
        params: { sessionId },
      }),
    resume: () =>
      requestResult(server, {
        id: "record-resume",
        method: zcodeProtocolMethods.sessionResume,
        params: { sessionId, workspace },
      }),
    async close() {
      registerSecond.resolve();
      for (const generation of generations) generation.completion.resolve({});
      await server.shutdown();
      server.disposeProjections();
      store.close();
    },
  };
}

describe("v4 queue auto-drain foreground races", () => {
  it("真实 record 换代：旧 mutation 在新 Core 构造与注册间返回，不能抢占新 app 观察归属", async () => {
    const h = await createRecordReplacementHarness();
    const oldMutation = deferred<[]>();
    const newTarget = deferred<{ status: "paused" }>();
    try {
      const old = h.generations[0]!;
      const oldRecord = h.record();
      await h.command("sendText");
      old.readTodos.mockClear();
      old.readTodos.mockImplementationOnce(() => oldMutation.promise);
      old.core(false);
      old.completion.resolve({});
      await vi.waitFor(() => expect(old.readTodos).toHaveBeenCalled());
      await h.closeSession();
      const resuming = h.resume();
      await h.secondConstructed.promise;
      const current = h.generations[1]!;
      expect(current.app).not.toBe(old.app);
      oldMutation.resolve([]);
      await vi.waitFor(() => expect(oldRecord.residencyFinalizationCount).toBe(0));
      h.registerSecond.resolve();
      await resuming;
      expect(h.record()).not.toBe(oldRecord);
      expect(h.record().app).toBe(current.app);
      current.emit(SessionEventType.SessionResumed, {});
      current.readTarget.mockClear();
      await h.command("sendText");
      current.queue();
      current.readTarget
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => newTarget.promise);
      const handoffStart = h.snapshots.length - 1;
      current.core(false);
      current.completion.resolve({});
      await vi.waitFor(() => expect(current.readTarget).toHaveBeenCalledTimes(2));
      expect(h.snapshots.at(-1)?.sessions).toMatchObject([{ instanceId: 2, busy: true }]);
      for (const snapshot of h.snapshots.slice(handoffStart))
        expect(snapshot.sessions).toMatchObject([{ instanceId: 2, busy: true }]);
      expect(current.reserveQueueItem).not.toHaveBeenCalled();
      newTarget.resolve({ status: "paused" });
      await vi.waitFor(() => expect(h.record().residencyFinalizationCount).toBe(0));
      expect(h.snapshots.at(-1)?.sessions).toMatchObject([{ instanceId: 2, busy: false }]);
    } finally {
      oldMutation.resolve([]);
      newTarget.resolve({ status: "paused" });
      await h.close();
    }
  });

  it("真实 record 换代：旧 retry timer 不阻挡新 record，held 判定后不遗留 active 观察", async () => {
    const h = await createRecordReplacementHarness();
    vi.useFakeTimers();
    try {
      const old = h.generations[0]!;
      const oldRecord = h.record();
      old.core(true);
      old.queue();
      await h.command("setAutoDrain");
      await vi.advanceTimersByTimeAsync(50);
      await h.closeSession();
      h.registerSecond.resolve();
      await h.resume();
      const current = h.generations[1]!;
      expect(current.app).not.toBe(old.app);
      expect(h.record()).not.toBe(oldRecord);
      current.emit(SessionEventType.SessionResumed, {});
      current.core(true);
      current.queue();
      await h.command("setAutoDrain");
      current.readTarget.mockClear();
      await vi.advanceTimersByTimeAsync(50);
      expect(current.readTarget).not.toHaveBeenCalled();
      current.readTarget.mockResolvedValue({ status: "paused" });
      current.core(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(current.readTarget).toHaveBeenCalledOnce();
      expect(h.snapshots.at(-1)?.sessions).toMatchObject([{ instanceId: 2, busy: false }]);
      expect(old.reserveQueueItem).not.toHaveBeenCalled();
      expect(current.reserveQueueItem).not.toHaveBeenCalled();
    } finally {
      await h.close();
      vi.useRealTimers();
    }
  });

  it("activity：ACK 前预留，terminal 到 mutation/readTarget/remove 的已有交接连续 busy", async () => {
    const h = await createActivityHarness();
    const snapshotGate = deferred<[]>();
    const targetGate = deferred<null>();
    const removing = deferred<void>();
    try {
      await h.command("sendText", { text: "A" });
      expect(h.counts).toEqual([0, 1]);
      h.queue();
      h.readTodos.mockImplementationOnce(() => snapshotGate.promise);
      h.readTarget.mockResolvedValueOnce(null).mockImplementationOnce(() => targetGate.promise);
      h.removeQueueItem.mockImplementationOnce(async () => {
        await removing.promise;
        return true;
      });
      h.core(false);
      h.completion.resolve({});
      await vi.waitFor(() => expect(h.readTodos).toHaveBeenCalledOnce());
      expect(h.counts).toEqual([0, 1]);
      expect(h.reserveQueueItem).not.toHaveBeenCalled();
      snapshotGate.resolve([]);
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledTimes(2));
      expect(h.counts).toEqual([0, 1]);
      targetGate.resolve(null);
      await vi.waitFor(() => expect(h.removeQueueItem).toHaveBeenCalledOnce());
      expect(h.sendInput).toHaveBeenCalledTimes(2);
      expect(h.acquireForegroundPromotionLease).toHaveBeenCalledOnce();
      expect(h.counts).toEqual([0, 1]);
      h.emit(SessionEventType.TurnSteerDiscarded, {
        pendingInputIds: ["queued-b"],
        reason: "promoted",
      });
      removing.resolve();
      h.core(false);
      h.promotedCompletion.resolve({});
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
    } finally {
      snapshotGate.resolve([]);
      targetGate.resolve(null);
      removing.resolve();
      await h.close();
    }
  });

  it("activity：raw queue 投影缺口未提交时旧空队首不能提前归零", async () => {
    const h = await createActivityHarness();
    try {
      await h.command("sendText", { text: "A" });
      h.queue("queued-b", 3);
      h.core(false);
      h.completion.resolve({});
      await vi.waitFor(() => expect(h.readTodos).toHaveBeenCalledOnce());
      expect(h.counts).toEqual([0, 1]);
      expect(h.reserveQueueItem).not.toHaveBeenCalled();
      h.emit(SessionEventType.SessionTitleUpdated, { title: "gap", source: "custom" }, 2);
      await vi.waitFor(() => expect(h.sendInput).toHaveBeenCalledTimes(2));
      expect(h.counts).toEqual([0, 1]);
      h.core(false);
      h.promotedCompletion.resolve({});
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
    } finally {
      await h.close();
    }
  });

  it.each(["active", "paused", "budget_limited", "read-failed", "auto-drain-disabled"])(
    "activity：%s 的真实 held 裁决释放交接，不把保留队列算运行",
    async (status) => {
      const h = await createActivityHarness();
      try {
        await h.command("sendText", { text: "A" });
        h.queue();
        h.readTarget.mockResolvedValueOnce(null);
        if (status === "read-failed")
          h.readTarget.mockRejectedValueOnce(new Error("controlled read failure"));
        else h.readTarget.mockResolvedValueOnce({ status });
        if (status === "auto-drain-disabled")
          h.emit(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });
        h.core(false);
        h.completion.resolve({});
        await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
        expect(h.sendInput).toHaveBeenCalledOnce();
        expect(h.reserveQueueItem).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    },
  );

  it("activity：同队首 target 换代时迟到读取不能清新观察或提升旧资格", async () => {
    const h = await createActivityHarness();
    const oldRead = deferred<null>();
    try {
      await h.command("sendText", { text: "A" });
      h.queue();
      h.readTarget
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => oldRead.promise)
        .mockResolvedValue({ status: "paused" });
      h.core(false);
      h.completion.resolve({});
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledTimes(2));
      h.emit(SessionEventType.TargetChanged, { target: { status: "paused", objective: "held" } });
      oldRead.resolve(null);
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
      expect(h.readTarget).toHaveBeenCalledTimes(3);
      expect(h.reserveQueueItem).not.toHaveBeenCalled();
    } finally {
      oldRead.resolve(null);
      await h.close();
    }
  });

  it("activity：close/resume 新实例不会被旧 Core close 或 completion finally 清零", async () => {
    const h = await createActivityHarness();
    const oldSnapshot = deferred<[]>();
    try {
      await h.command("sendText", { text: "A" });
      h.readTodos.mockImplementationOnce(() => oldSnapshot.promise);
      h.core(false);
      h.completion.resolve({});
      await vi.waitFor(() => expect(h.readTodos).toHaveBeenCalledOnce());
      h.replaceInstance();
      h.core(false, true, 1);
      oldSnapshot.resolve([]);
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalled());
      expect(h.counts).toEqual([0, 1]);
      h.core(false);
      expect(h.counts).toEqual([0, 1, 0]);
    } finally {
      oldSnapshot.resolve([]);
      await h.close();
    }
  });

  it("activity：队首替换后旧 readTarget 只重评当前项，真实 promotion 恰好一次", async () => {
    const h = await createActivityHarness();
    const oldRead = deferred<null>();
    try {
      await h.command("sendText", { text: "A" });
      h.queue("old-head");
      h.readTarget
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => oldRead.promise)
        .mockResolvedValue(null);
      h.core(false);
      h.completion.resolve({});
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledTimes(2));
      h.emit(SessionEventType.TurnSteerDiscarded, {
        pendingInputIds: ["old-head"],
        reason: "deleted",
      });
      h.queue("new-head");
      oldRead.resolve(null);
      await vi.waitFor(() => expect(h.sendInput).toHaveBeenCalledTimes(2));
      expect(h.reserveQueueItem).toHaveBeenCalledOnce();
      expect(h.reserveQueueItem.mock.calls[0]?.[0]).toBe("new-head");
      expect(h.acquireForegroundPromotionLease).toHaveBeenCalledOnce();
      expect(h.counts).toEqual([0, 1]);
      h.core(false);
      h.promotedCompletion.resolve({});
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
    } finally {
      oldRead.resolve(null);
      await h.close();
    }
  });

  it("activity：readTarget 等待中重排队列必须按新队首重评，不能提升旧项", async () => {
    const h = await createActivityHarness();
    const oldRead = deferred<null>();
    try {
      await h.command("sendText", { text: "A" });
      h.queue("old-head");
      h.queue("new-head");
      h.readTarget
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => oldRead.promise)
        .mockResolvedValue(null);
      h.core(false);
      h.completion.resolve({});
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledTimes(2));
      h.emit(SessionEventType.TurnSteerReordered, {
        orderedPendingInputIds: ["new-head", "old-head"],
      });
      oldRead.resolve(null);
      await vi.waitFor(() => expect(h.sendInput).toHaveBeenCalledTimes(2));
      expect(h.reserveQueueItem).toHaveBeenCalledOnce();
      expect(h.reserveQueueItem.mock.calls[0]?.[0]).toBe("new-head");
      expect(h.readTarget).toHaveBeenCalledTimes(3);
      expect(h.counts).toEqual([0, 1]);
    } finally {
      oldRead.resolve(null);
      await h.close();
    }
  });

  it("activity：同 raw 序号的被丢弃事件不遗留投影观察，已有队列仍只提升一次", async () => {
    const h = await createActivityHarness();
    try {
      await h.command("sendText", { text: "A" });
      h.queue("queued-b", 3);
      h.emit(
        SessionEventType.TargetChanged,
        { target: { status: "paused", objective: "duplicate raw sequence" } },
        3,
        "duplicate-sequence-event",
      );
      h.core(false);
      h.completion.resolve({});
      h.emit(SessionEventType.SessionTitleUpdated, { title: "gap", source: "custom" }, 2);
      await vi.waitFor(() => expect(h.sendInput).toHaveBeenCalledTimes(2));
      expect(h.reserveQueueItem).toHaveBeenCalledOnce();
      expect(h.counts).toEqual([0, 1]);
      h.core(false);
      h.promotedCompletion.resolve({});
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
    } finally {
      await h.close();
    }
  });

  it("activity：Core-only busy 的既有 retry 接棒，后续 held 即归零且旧 timer 不续命", async () => {
    const h = await createActivityHarness();
    try {
      h.core(true);
      h.queue();
      vi.useFakeTimers();
      await h.command("setAutoDrain", { autoDrain: true });
      expect(h.reserveQueueItem).not.toHaveBeenCalled();
      h.core(false);
      expect(h.counts).toEqual([0, 1]);
      h.readTarget.mockResolvedValue({ status: "paused" });
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
      expect(h.reserveQueueItem).not.toHaveBeenCalled();
      expect(h.sendInput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await h.close();
    }
  });

  it("activity：TargetChanged complete 在原 detached gate 前同步接棒，start 后失败暂停原队列", async () => {
    const h = await createActivityHarness();
    const target = deferred<null>();
    try {
      h.queue();
      h.readTarget.mockImplementationOnce(() => target.promise);
      h.reserveQueueItem.mockRejectedValueOnce(new Error("controlled promotion failure"));
      h.emit(SessionEventType.TargetChanged, { target: { status: "complete", objective: "done" } });
      // detached Promise.then 尚未运行；同一同步 owner 已保留实际重评事实。
      expect(h.counts).toEqual([0, 1]);
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledOnce());
      target.resolve(null);
      await vi.waitFor(() => expect(h.setQueueAutoDrain).toHaveBeenCalledWith(false));
      await vi.waitFor(() => expect(h.counts).toEqual([0, 1, 0]));
      expect(h.acquireForegroundPromotionLease).toHaveBeenCalledOnce();
      expect(h.reserveQueueItem).toHaveBeenCalledOnce();
      expect(h.sendInput).not.toHaveBeenCalled();
    } finally {
      target.resolve(null);
      await h.close();
    }
  });

  it("activity：readTarget 等待时新 foreground 命令赢得 admission，原 idle-only gate 只重试", async () => {
    const h = await createActivityHarness();
    const target = deferred<null>();
    try {
      h.queue();
      h.readTarget.mockResolvedValueOnce(null).mockImplementationOnce(() => target.promise);
      const draining = h.command("setAutoDrain", { autoDrain: true });
      await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledTimes(2));
      h.core(true);
      h.acquireForegroundPromotionLease.mockReturnValueOnce({ kind: "busy" });
      target.resolve(null);
      await draining;
      expect(h.reserveQueueItem).not.toHaveBeenCalled();
      expect(h.counts).toEqual([0, 1]);
      h.emit(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });
      h.core(false);
      expect(h.counts).toEqual([0, 1, 0]);
      expect(h.sendInput).not.toHaveBeenCalled();
    } finally {
      target.resolve(null);
      await h.close();
    }
  });

  it("BG43：Core-only notification 活跃时 auto-drain 不得抢占 foreground", async () => {
    let sessionEventSink: ((event: SessionEvent) => void) | undefined;
    let sequenceNumber = 0;
    let activeForegroundExecutionId: string | undefined;
    let rejectNextIdlePromotion = true;
    let emitEvent!: (type: SessionEvent["type"], payload: unknown, turnId?: string) => SessionEvent;
    const stopActiveForegroundExecution = vi.fn().mockImplementation(() => {
      const stoppedId = activeForegroundExecutionId;
      activeForegroundExecutionId = undefined;
      return stoppedId
        ? { kind: "stopped" as const, foregroundExecutionId: stoppedId }
        : { kind: "idle" as const };
    });
    const acquireForegroundPromotionLease = vi.fn().mockImplementation(({ leaseId }) => {
      if (rejectNextIdlePromotion) {
        rejectNextIdlePromotion = false;
        return { kind: "busy" as const };
      }
      return { kind: "acquired" as const, leaseId };
    });
    const reserveQueueItem = vi.fn().mockImplementation(async (_queueItemId, reservationId) => {
      emitEvent(SessionEventType.TurnSteerDispatchChanged, {
        pendingInputId: "queue-bg43",
        reservationId,
        state: "reserved",
        targetTurnId: "turn-before-bg43",
      });
      return true;
    });
    const markQueueItemPromoting = vi
      .fn()
      .mockImplementation(async (_queueItemId, reservationId) => {
        emitEvent(SessionEventType.TurnSteerDispatchChanged, {
          pendingInputId: "queue-bg43",
          reservationId,
          state: "promoting",
          targetTurnId: "turn-before-bg43",
        });
        return true;
      });
    const removeQueueItem = vi.fn().mockImplementation(async () => {
      emitEvent(SessionEventType.TurnSteerDiscarded, {
        pendingInputIds: ["queue-bg43"],
        reason: "promoted",
        targetTurnId: "turn-before-bg43",
      });
      return true;
    });
    const setQueueAutoDrain = vi.fn().mockResolvedValue(undefined);
    const sendInput = vi
      .fn()
      .mockImplementation(
        async (
          _input: unknown,
          options?: { onTurnStartedObserved?: (event: SessionEvent) => void },
        ) => {
          const turnStarted = emitEvent(
            SessionEventType.TurnStarted,
            {
              input: "BG43 queued text",
              inputId: "source-bg43",
              messageId: "message-bg43",
              turnNumber: 2,
            },
            "turn-promoted-bg43",
          );
          options?.onTurnStartedObserved?.(turnStarted);
          return {};
        },
      );

    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options: ZCodeAppOptions) => {
        const app = createFakeApp(options);
        return {
          ...app,
          markQueueItemPromoting,
          readTarget: vi.fn().mockResolvedValue(null),
          releaseQueueItemReservation: vi.fn().mockResolvedValue(true),
          removeQueueItem,
          reserveQueueItem,
          sendInput,
          setQueueAutoDrain,
          runtime: {
            ...app.runtime,
            acquireForegroundPromotionLease,
            getActiveForegroundExecutionId: () => activeForegroundExecutionId,
            stopActiveForegroundExecution,
            subscribeEvents: (sink) => {
              sessionEventSink = sink.onSessionEvent;
              return () => {};
            },
          },
        } as ZCodeApp;
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const created = (await requestResult(server, {
      id: "create-bg43",
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    })) as { session: { sessionId: string } };
    const sessionId = created.session.sessionId as SessionId;
    const traceId = createTraceId("trace-bg43");
    emitEvent = (type, payload, turnId) => {
      sequenceNumber += 1;
      const event = {
        id: `event-bg43-${sequenceNumber}`,
        payload,
        sequenceNumber,
        sessionId,
        timestamp: new Date(1_700_000_000_000 + sequenceNumber),
        traceId,
        type,
        ...(turnId ? { turnId: createTurnId(turnId) } : {}),
      } as SessionEvent;
      sessionEventSink?.(event);
      return event;
    };

    emitEvent(SessionEventType.SessionCreated, {
      contextWindow: 128_000,
      mode: "build",
    });
    emitEvent(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-bg43",
        inputId: "source-bg43",
        input: "BG43 queued text",
        inputPreview: "BG43 queued text",
        inputSize: 16,
        delivery: "queue",
        targetTurnId: "turn-before-bg43",
        queueLength: 1,
        intent: {
          sourceCommandId: "source-bg43",
          queueItemId: "queue-bg43",
          clientId: "desktop-bg43",
          kind: "sendText",
          admissionSeq: 1,
          admittedAt: 1_700_000_000_002,
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
      },
      "turn-before-bg43",
    );
    emitEvent(SessionEventType.QueueAutoDrainChanged, { autoDrain: true });
    activeForegroundExecutionId = "notification-bg43";

    const subscriptionRequestId = "subscribe-bg43";
    await requestResult(server, {
      id: subscriptionRequestId,
      method: V4_METHODS.conversationSubscribe,
      params: {
        clientMode: "desktop-continuous",
        connectionId: "connection-bg43",
        topic: conversationTopic(sessionId),
      },
    });
    const assembled = reassembleTopicWireFrames(
      server
        .takePostResponseMessages(subscriptionRequestId)
        .map((message) => routedTopicWireFrameSchema.parse(message.params)),
      conversationTopicFrameSchema,
    );
    if (assembled.kind !== "complete" || assembled.frame.payload.kind !== "snapshot") {
      throw new Error("Expected complete BG43 conversation snapshot");
    }
    expect(assembled.frame.payload.snapshot.queue).toMatchObject({
      autoDrain: true,
      items: [
        expect.objectContaining({
          queueItemId: "queue-bg43",
          dispatch: { state: "queued" },
        }),
      ],
    });

    const autoDrainAck = await requestResult(server, {
      id: "resume-auto-drain-bg43",
      method: V4_METHODS.command,
      params: {
        baseRevision: assembled.frame.payload.snapshot.revision,
        clientId: "desktop-bg43",
        commandId: "set-auto-drain-bg43",
        issuedAt: 1_700_000_000_003,
        payload: { autoDrain: true },
        sessionId,
        type: "setAutoDrain",
      },
    });

    if ((autoDrainAck as { status?: string }).status !== "accepted") {
      throw new Error(`Unexpected BG43 command ACK: ${JSON.stringify(autoDrainAck)}`);
    }
    expect(setQueueAutoDrain).toHaveBeenCalledWith(true);
    expect(activeForegroundExecutionId).toBe("notification-bg43");
    expect(stopActiveForegroundExecution).not.toHaveBeenCalled();
    expect(reserveQueueItem).not.toHaveBeenCalled();
    expect(markQueueItemPromoting).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(removeQueueItem).not.toHaveBeenCalled();

    activeForegroundExecutionId = undefined;
    await vi.waitFor(() => {
      expect(acquireForegroundPromotionLease).toHaveBeenCalledTimes(2);
      expect(reserveQueueItem).toHaveBeenCalledOnce();
      expect(markQueueItemPromoting).toHaveBeenCalledOnce();
      expect(sendInput).toHaveBeenCalledOnce();
      expect(removeQueueItem).toHaveBeenCalledOnce();
    });
    expect(stopActiveForegroundExecution).not.toHaveBeenCalled();
  });
});
