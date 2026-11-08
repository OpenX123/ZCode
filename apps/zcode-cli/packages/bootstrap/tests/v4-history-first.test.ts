import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it, vi } from "vitest";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(
  lookupTranscriptCommand?: () => {
    commandId: string;
    status: "accepted";
    revisionAtDecision: number;
  },
  retainSessionRuntime?: () => Promise<() => void>,
) {
  const gate = deferred();
  const frames: ConversationTopicFrame[] = [];
  let observed: ConversationSnapshot | undefined;
  const execute = vi.fn();
  const resume = vi.fn(async () => {
    await gate.promise;
    return { status: "resumed" as const, persistedMessages: [] };
  });
  const read = vi.fn(async () => []);
  const loadPersistedEvents = vi.fn(async () => ({
    events: [],
    synthesized: true,
    sourceEventSeq: 0,
  }));
  const perf: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const gateway = new ConversationV4Gateway({
    sessionExists: () => false,
    onPerf: (event, fields) => perf.push({ event, fields }),
    executeCommand: execute,
    lookupTranscriptCommand,
    retainSessionRuntime,
    loadPersistedMessages: read,
    resumePersistedSession: resume,
    loadPersistedEvents,
    emitWireFrame: (wire) => {
      if (wire.kind === "complete") {
        const frame = wire.frame as ConversationTopicFrame;
        frames.push(frame);
        if (frame.payload.kind === "snapshot") observed = frame.payload.snapshot;
        else if (observed)
          observed = {
            ...applyConversationDeltas(observed, frame.payload.deltas),
            seq: frame.toSeq,
          };
      }
    },
  });
  const params = {
    topic: "conversation/history",
    connectionId: "desktop",
    clientMode: "desktop-continuous",
    historyFirst: true,
  };
  const snapshot = () => observed;
  return {
    gateway,
    gate,
    frames,
    execute,
    resume,
    read,
    params,
    snapshot,
    loadPersistedEvents,
    perf,
    seed: (frame: ConversationTopicFrame | null) => {
      if (frame?.payload.kind === "snapshot") observed = frame.payload.snapshot;
    },
  };
}

describe("history-first cold subscription", () => {
  it.each(["desktop-continuous", "web-remote-replayable"])(
    "%s preserves project directories alongside the persisted history snapshot",
    async (clientMode) => {
      const { gateway, gate, resume, params, snapshot, seed } = setup();
      const workspace = { workspacePath: "/project", workspaceKey: "/project" };
      const additionalDirectories = ["/shared"];
      seed((await gateway.subscribe({ ...params, clientMode, workspace, additionalDirectories })).initialFrame);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      expect(resume).toHaveBeenCalledWith(
        "history",
        undefined,
        workspace,
        additionalDirectories,
        [],
        expect.objectContaining({ onRecordRegistered: expect.any(Function) }),
      );
      gate.resolve();
      await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
      gateway.dispose();
    },
  );

  it("publishes history before activation and rejects execution while restoring", async () => {
    const { gateway, gate, resume, read, execute, params, snapshot, seed } = setup();
    const dispatch = await gateway.subscribeReserved(params);
    expect(resume).not.toHaveBeenCalled();
    expect(dispatch.initialFrame?.payload.kind).toBe("snapshot");
    if (dispatch.initialFrame?.payload.kind !== "snapshot") throw new Error("missing history");
    expect(dispatch.initialFrame.payload.snapshot.runtimeInitialization?.status).toBe(
      "initializing",
    );
    seed(dispatch.initialFrame);
    dispatch.commit();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    const rows = await gateway.rowsRange({ sessionId: "history", limit: 10 });
    expect(rows.rows).toEqual([]);
    const ack = await gateway.handleCommand({
      commandId: "early",
      sessionId: "history",
      type: "compact",
      payload: {},
      clientId: "client",
      issuedAt: Date.now(),
    });
    expect(ack.status).toBe("rejected");
    expect(ack.reasonCode).toBe("guard.runtimeInitializing");
    expect(execute).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);
    gateway.dispose();
  });

  it("retains failed history until explicit retry and coalesces repeated retry", async () => {
    const { gateway, gate, resume, params, snapshot, seed } = setup();
    seed((await gateway.subscribe(params)).initialFrame);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    gate.reject(new Error("hook unavailable"));
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("failed"));
    const attempt = snapshot()!.runtimeInitialization!.attemptId;
    await gateway.subscribe({ ...params, connectionId: "reconnect" });
    await expect(
      gateway.subscribe({ ...params, historyFirst: false, connectionId: "old-client" }),
    ).rejects.toMatchObject({ reasonCode: "fault.subscribe.resumeFailed" });
    expect(resume).toHaveBeenCalledTimes(1);
    resume.mockImplementationOnce(async () => ({ status: "resumed", persistedMessages: [] }));
    await Promise.all([
      gateway.subscribe({ ...params, retryInitialization: attempt }),
      gateway.subscribe({
        ...params,
        connectionId: "phone",
        clientMode: "web-remote-replayable",
        retryInitialization: attempt,
      }),
    ]);
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    expect(resume).toHaveBeenCalledTimes(2);
    gateway.dispose();
  });

  it("cleans the activated runtime when final history reconciliation fails", async () => {
    const { gateway, params, resume, snapshot, seed, loadPersistedEvents } = setup();
    const disposeOnFailure = vi.fn(async () => undefined);
    resume.mockImplementationOnce(async () => ({
      status: "resumed",
      persistedMessages: [],
      disposeOnFailure,
    }));
    seed((await gateway.subscribe(params)).initialFrame);
    loadPersistedEvents.mockRejectedValueOnce(new Error("storage unavailable"));
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("failed"));
    expect(disposeOnFailure).toHaveBeenCalledTimes(1);
    gateway.dispose();
  });

  it("keeps durable command deduplication ahead of initialization guards", async () => {
    const { gateway, gate, params, execute } = setup(() => ({
      commandId: "settled",
      status: "accepted",
      revisionAtDecision: 1,
    }));
    await gateway.subscribe(params);
    const ack = await gateway.handleCommand({
      commandId: "settled",
      sessionId: "history",
      type: "compact",
      payload: {},
      clientId: "client",
      issuedAt: Date.now(),
    });
    expect(ack.status).toBe("duplicate");
    expect(execute).not.toHaveBeenCalled();
    gateway.dispose();
    gate.resolve();
  });

  it("does not activate a disposed opening when its reserved frame commits late", async () => {
    const { gateway, gate, params, resume } = setup();
    const dispatch = await gateway.subscribeReserved(params);
    gateway.dispose();
    dispatch.commit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resume).not.toHaveBeenCalled();
    gate.resolve();
  });

  it("keeps legacy subscribers behind runtime readiness", async () => {
    const { gateway, gate, params } = setup();
    await gateway.subscribe(params);
    let returned = false;
    const legacy = gateway
      .subscribe({ ...params, historyFirst: false, connectionId: "legacy" })
      .then(() => {
        returned = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    gate.resolve();
    await legacy;
    gateway.dispose();
  });

  it("releases a delayed residency lease after the opening was disposed", async () => {
    const lease = deferred();
    const release = vi.fn();
    const retain = vi.fn(async () => {
      await lease.promise;
      return release;
    });
    const { gateway, params, resume } = setup(undefined, retain);
    await gateway.subscribe(params);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledTimes(1));
    gateway.dispose();
    lease.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(resume).not.toHaveBeenCalled();
  });
});

// P4（docs/design/v2/zcode-protocol-agent-server.md「会话只读不排队」）：外部引擎会话的 history-first
// 打开期间，runtime 恢复含外部引擎握手（生产 14.2s）。同会话只读直接读已持久化数据，不等 READY。
describe("history-first 打开期间的会话只读", () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("plans 读 history publisher，不等待 runtime 就绪；打开期间会话可越过分道读取", async () => {
    const { gateway, gate, resume, params, seed, snapshot } = setup();
    expect(gateway.canServeSessionRead("history")).toBe(false);
    seed((await gateway.subscribe(params)).initialFrame);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(gateway.canServeSessionRead("history")).toBe(true);
    // 从未打开的冷会话：读取会触发激活，不能越过分道。
    expect(gateway.canServeSessionRead("other")).toBe(false);

    let plans: Awaited<ReturnType<typeof gateway.plans>> | undefined;
    void gateway.plans({ sessionId: "history" }).then((result) => {
      plans = result;
    });
    await vi.waitFor(() => expect(plans).toBeDefined());
    expect(plans!.plans).toEqual([]);
    expect(snapshot()?.runtimeInitialization?.status).toBe("initializing");

    gate.resolve();
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    gateway.dispose();
  });

  it("workflow journal 读只等会话 record 入册，不等外部引擎握手完成", async () => {
    const handshake = deferred();
    let registered = false;
    const listDynamicWorkflowRuns = vi.fn(async () => []);
    const gateway = new ConversationV4Gateway({
      sessionExists: () => registered,
      executeCommand: vi.fn(),
      loadPersistedMessages: vi.fn(async () => []),
      loadPersistedEvents: vi.fn(async () => ({ events: [], synthesized: true, sourceEventSeq: 0 })),
      listDynamicWorkflowRuns,
      resumePersistedSession: vi.fn(async (_id, _thought, _ws, _dirs, _messages, hooks) => {
        // record 入册（activateSessionForResume 的 sessions.set）先于 runtime.resume 的握手。
        await settle();
        registered = true;
        hooks?.onRecordRegistered?.();
        await handshake.promise;
        return { status: "resumed" as const, persistedMessages: [] };
      }),
      emitWireFrame: () => undefined,
    });
    await gateway.subscribe({
      topic: "conversation/history",
      connectionId: "desktop",
      clientMode: "desktop-continuous",
      historyFirst: true,
    });
    let runs: unknown;
    void gateway.workflowRuns({ sessionId: "history" }).then((result) => {
      runs = result;
    });
    await vi.waitFor(() => expect(runs).toEqual({ runs: [] }));
    expect(listDynamicWorkflowRuns).toHaveBeenCalledWith("history", {});
    handshake.resolve();
    gateway.dispose();
  });
});

// P11（docs/desktop/engine-performance-1.1-spec.md §6）：冷订阅分阶段 info 打点，只含耗时与计数。
describe("冷订阅分阶段打点", () => {
  it("history-first 打开记录 cold_open（首帧前各阶段）与 runtime_ready（后台恢复后）", async () => {
    const { gateway, gate, params, seed, snapshot, perf } = setup();
    seed((await gateway.subscribe(params)).initialFrame);
    const coldOpen = perf.filter((item) => item.event === "zcode_protocol.v4.subscribe.cold_open");
    expect(coldOpen).toHaveLength(1);
    expect(coldOpen[0]!.fields).toMatchObject({
      sessionId: "history",
      path: "historyFirst",
      messageCount: 0,
      partCount: 0,
      eventCount: 0,
      synthesized: true,
      rowCount: 0,
      loadMessagesMs: expect.any(Number),
      loadEventsMs: expect.any(Number),
      rehydrateMs: expect.any(Number),
      hydrateMs: expect.any(Number),
      snapshotEncodeMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    // 字段只允许数字、布尔与枚举/标识，不含正文或路径。
    for (const value of Object.values(coldOpen[0]!.fields))
      expect(["number", "boolean", "string"]).toContain(typeof value);

    gate.resolve();
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    const ready = perf.filter((item) => item.event === "zcode_protocol.v4.subscribe.runtime_ready");
    expect(ready).toEqual([
      {
        event: "zcode_protocol.v4.subscribe.runtime_ready",
        fields: expect.objectContaining({
          sessionId: "history",
          resumeMs: expect.any(Number),
          rehydrateMs: expect.any(Number),
          totalMs: expect.any(Number),
        }),
      },
    ]);
    gateway.dispose();
  });
});
