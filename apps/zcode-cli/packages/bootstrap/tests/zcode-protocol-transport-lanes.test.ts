import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import {
  planProtocolDispatch,
  ZCodeProtocolNdjsonConnection,
} from "../src/zcode-protocol/transport.js";

type Handler = (message: ZCodeProtocolMessage) => Promise<unknown>;

/** 每个请求一个可手动放行的闸门；记录开始顺序与已写出的响应 id。 */
function createHarness(options: { logger?: Logger; now?: () => number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const started: string[] = [];
  const responded: unknown[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const gate = (id: string) => {
    let entry = gates.get(id);
    if (!entry) {
      entry = Promise.withResolvers<void>();
      gates.set(id, entry);
    }
    return entry;
  };
  const blocked = new Set<string>();
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (line) responded.push((JSON.parse(line) as { id?: unknown }).id);
    }
  });
  let extra: Handler | undefined;
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
    handleMessage: async (message) => {
      if (!("method" in message) || !("id" in message)) return undefined;
      const id = String(message.id);
      started.push(id);
      await extra?.(message);
      if (blocked.has(id)) await gate(id).promise;
      return { id: message.id, result: {} };
    },
  });
  connection.start();
  return {
    connection,
    input,
    started,
    responded,
    block: (...ids: string[]) => {
      for (const id of ids) blocked.add(id);
    },
    release: (id: string) => gate(id).resolve(),
    onMessage: (handler: Handler) => {
      extra = handler;
    },
    send: (...messages: ZCodeProtocolMessage[]) =>
      input.write(messages.map((message) => `${JSON.stringify(message)}\n`).join("")),
  };
}

function request(id: string, method: string, params?: unknown): ZCodeProtocolMessage {
  return { id, method, ...(params === undefined ? {} : { params }) } as ZCodeProtocolMessage;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ZCode Protocol 传输分道", () => {
  it("不同会话并发执行，同一会话按到达顺序开始", async () => {
    const harness = createHarness();
    harness.block("a1");
    harness.send(
      request("a1", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_a" }),
      request("a2", V4_METHODS.conversationRowsRange, { sessionId: "sess_a" }),
      request("b1", V4_METHODS.conversationRowsRange, { sessionId: "sess_b" }),
    );
    await vi.waitFor(() => expect(harness.responded).toContain("b1"));
    // A 会话的冷操作不再挡住 B 会话的读取；A 会话自己的后续请求仍在它之后。
    expect(harness.started).toEqual(["a1", "b1"]);
    harness.release("a1");
    await vi.waitFor(() => expect(harness.responded).toEqual(["b1", "a1", "a2"]));
    expect(harness.started).toEqual(["a1", "b1", "a2"]);
    harness.input.end();
    await harness.connection.waitForClose();
  });

  it("Host 预留 sessionId 的 createSession 先于同会话订阅，不挡其他会话的订阅", async () => {
    const harness = createHarness();
    harness.block("create");
    harness.send(
      request("create", V4_METHODS.command, {
        commandId: "cmd-1",
        clientId: "client",
        sessionId: null,
        type: "createSession",
        payload: { sessionId: "sess_new", workspaceId: "ws" },
        issuedAt: 0,
      }),
      request("subscribe-new", V4_METHODS.conversationSubscribe, {
        topic: "conversation/sess_new",
      }),
      request("subscribe-old", V4_METHODS.conversationSubscribe, {
        topic: "conversation/sess_old",
      }),
    );
    await vi.waitFor(() => expect(harness.responded).toContain("subscribe-old"));
    expect(harness.started).not.toContain("subscribe-new");
    harness.release("create");
    await vi.waitFor(() => expect(harness.responded).toContain("subscribe-new"));
    expect(harness.started.indexOf("create")).toBeLessThan(
      harness.started.indexOf("subscribe-new"),
    );
    harness.input.end();
    await harness.connection.waitForClose();
  });

  it("无会话纯读不等待任何分道", async () => {
    const harness = createHarness();
    harness.block("install", "compact");
    harness.send(
      request("install", zcodeProtocolMethods.pluginsInstall, {}),
      request("compact", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_a" }),
      request("presentation", zcodeProtocolMethods.workspaceReadPresentation, {
        workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
      }),
      request("list", zcodeProtocolMethods.sessionList, { sessionIds: ["sess_a"] }),
      request("reconcile", V4_METHODS.sessionsIndexReconcile, {
        workspaceId: "/ws",
        sessionIds: ["sess_a"],
      }),
      request("clock", V4_METHODS.commandsQuery, {
        commands: [{ sessionId: "sess_a", commandId: "cmd" }],
        clock: true,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.responded).toEqual(
        expect.arrayContaining(["presentation", "list", "reconcile", "clock"]),
      ),
    );
    expect(harness.responded).not.toContain("install");
    expect(harness.responded).not.toContain("compact");
    harness.release("install");
    harness.release("compact");
    harness.input.end();
    await harness.connection.waitForClose();
  });

  it("全局分道保持 FIFO，插件取消旁路正在执行的安装", async () => {
    const harness = createHarness();
    harness.block("install");
    let cancelSawInstallActive = false;
    harness.onMessage(async (message) => {
      if ("method" in message && message.method === zcodeProtocolMethods.pluginsCancelOperation) {
        cancelSawInstallActive =
          harness.started.includes("install") && !harness.responded.includes("install");
      }
    });
    harness.send(
      request("install", zcodeProtocolMethods.pluginsInstall, { operationId: "op-1" }),
      request("cancel", zcodeProtocolMethods.pluginsCancelOperation, { operationId: "op-1" }),
      request("trust", zcodeProtocolMethods.workspaceHookTrustGrant, {}),
    );
    await vi.waitFor(() => expect(harness.responded).toContain("cancel"));
    expect(cancelSawInstallActive).toBe(true);
    // 全局写仍排在安装之后。
    expect(harness.started).not.toContain("trust");
    harness.release("install");
    await vi.waitFor(() => expect(harness.responded).toContain("trust"));
    expect(harness.started).toEqual(["install", "cancel", "trust"]);
    harness.input.end();
    await harness.connection.waitForClose();
  });

  it("跨会话请求同时占用所涉及的会话分道", async () => {
    const harness = createHarness();
    harness.block("a1");
    harness.send(
      request("a1", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_a" }),
      request("query", V4_METHODS.commandsQuery, {
        commands: [
          { sessionId: "sess_a", commandId: "cmd-a" },
          { sessionId: "sess_b", commandId: "cmd-b" },
        ],
      }),
      request("b1", V4_METHODS.conversationPlans, { sessionId: "sess_b" }),
    );
    await flush();
    await flush();
    // query 要等 A 分道；B 分道排在 query 之后，因此 b1 也不能越过 query。
    expect(harness.started).toEqual(["a1"]);
    harness.release("a1");
    await vi.waitFor(() => expect(harness.responded).toEqual(["a1", "query", "b1"]));
    harness.input.end();
    await harness.connection.waitForClose();
  });

  it("会话停止只等同会话前序请求进入 handler，不受其他会话阻塞", async () => {
    const harness = createHarness();
    harness.block("blocking", "send");
    let stopSawActiveSend = false;
    harness.onMessage(async (message) => {
      if ("method" in message && message.method === zcodeProtocolMethods.sessionStop) {
        stopSawActiveSend = harness.started.includes("send");
        harness.release("send");
      }
    });
    harness.send(
      request("blocking", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_blocking" }),
      request("send", zcodeProtocolMethods.sessionSend, {
        sessionId: "sess_target",
        inputId: "input",
        content: "run",
      }),
      request("stop", zcodeProtocolMethods.sessionStop, { sessionId: "sess_target" }),
    );
    await vi.waitFor(() => expect(harness.responded).toContain("stop"));
    expect(stopSawActiveSend).toBe(true);
    expect(harness.responded).not.toContain("blocking");
    harness.release("blocking");
    harness.input.end();
    await harness.connection.waitForClose();
  });

  it("EOF 后等所有分道的在途请求写出响应再关闭", async () => {
    const harness = createHarness();
    harness.block("a1", "b1", "read");
    harness.send(
      request("a1", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_a" }),
      request("a2", V4_METHODS.conversationRowsRange, { sessionId: "sess_a" }),
      request("b1", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_b" }),
      request("read", zcodeProtocolMethods.workspaceReadPresentation, {}),
    );
    await vi.waitFor(() => expect(harness.started).toEqual(["read", "a1", "b1"]));
    harness.input.end();
    let closed = false;
    const closing = harness.connection.waitForClose().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    harness.release("b1");
    harness.release("read");
    harness.release("a1");
    await closing;
    // 已接收的请求（包括排在 a1 之后的 a2）都在关闭前写出。
    expect(harness.responded).toEqual(expect.arrayContaining(["a1", "a2", "b1", "read"]));
  });

  it("记录分道排队超过阈值与慢请求，字段只含方法与分道", async () => {
    let clock = 1_000;
    const info = vi.fn();
    const logger: Logger = {
      debug: () => undefined,
      info,
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
    };
    const harness = createHarness({ logger, now: () => clock });
    harness.block("a1");
    harness.send(
      request("a1", zcodeProtocolMethods.sessionCompact, { sessionId: "sess_a" }),
      request("a2", V4_METHODS.conversationRowsRange, { sessionId: "sess_a" }),
    );
    await vi.waitFor(() => expect(harness.started).toEqual(["a1"]));
    clock += 800;
    harness.release("a1");
    await vi.waitFor(() => expect(harness.responded).toEqual(["a1", "a2"]));
    expect(info).toHaveBeenCalledWith(
      "ZCode Protocol request slow",
      expect.objectContaining({
        durationMs: 800,
        event: "zcode_protocol.request.slow",
        lane: "session",
        method: zcodeProtocolMethods.sessionCompact,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "ZCode Protocol request waited in lane",
      expect.objectContaining({
        event: "zcode_protocol.request.queue_wait",
        lane: "session",
        method: V4_METHODS.conversationRowsRange,
        waitMs: 800,
      }),
    );
    const fields = info.mock.calls.map(([, context]) => context as Record<string, unknown>);
    expect(fields.every((context) => !("sessionId" in context) && !("params" in context))).toBe(
      true,
    );
    harness.input.end();
    await harness.connection.waitForClose();
  });
});

describe("planProtocolDispatch", () => {
  it.each([
    [request("1", zcodeProtocolMethods.sessionStop, { sessionId: "s" }), "control", ["session:s"]],
    [request("2", zcodeProtocolMethods.workspaceCancelGenerateText, {}), "control", ["workspace-model"]],
    [request("3", zcodeProtocolMethods.pluginsCancelOperation, {}), "control", ["global"]],
    [request("4", zcodeProtocolMethods.mcpUiCallTool, { sessionId: "s" }), "control", ["session:s"]],
    [request("5", zcodeProtocolMethods.workspaceGenerateText, {}), "lane", ["workspace-model"]],
    [request("6", zcodeProtocolMethods.mcpList, {}), "lane", ["global"]],
    [
      request("7", V4_METHODS.conversationSubscribe, { topic: "sessions-index/ws" }),
      "lane",
      ["topic:sessions-index/ws"],
    ],
    [request("8", "unknown/method", {}), "lane", ["global"]],
    [request("9", zcodeProtocolMethods.providerRefreshRegistry, {}), "immediate", undefined],
    [request("10", V4_METHODS.connectionFlow, {}), "immediate", undefined],
  ] as const)("把 %j 分到 %s", (message, kind, laneKeys) => {
    const plan = planProtocolDispatch(message);
    expect(plan.kind).toBe(kind);
    if (laneKeys) expect("laneKeys" in plan ? plan.laneKeys : undefined).toEqual(laneKeys);
  });
});
