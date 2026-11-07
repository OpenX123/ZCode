import type {
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { MCP_SERVER_START_FAILED_ERROR_CODE } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "../../src/mcp/pool.js";
import { createMcpTelemetryTracker } from "../../src/mcp/telemetry.js";
import type { McpToolManifestCache } from "../../src/mcp/lazy-start/index.js";

const CONFIG: McpServerConfig = { command: "node", args: ["server.js"], type: "stdio" };
const IDLE_MS = 10 * 60_000;

function tool(serverName: string, toolName: string, description = toolName): McpToolDescriptor {
  return { description, inputSchema: { type: "object" }, serverName, toolName };
}

/** 内存版工具清单缓存：记录读写与失效。 */
function createMemoryCache(initial: Record<string, McpToolDescriptor[]> = {}) {
  const manifests = new Map(Object.entries(initial));
  const cache: McpToolManifestCache & {
    manifests: Map<string, McpToolDescriptor[]>;
    invalidated: string[];
  } = {
    manifests,
    invalidated: [],
    read: vi.fn(async (serverName: string) => manifests.get(serverName)),
    write: vi.fn(async (serverName: string, _config, tools) => {
      manifests.set(serverName, [...tools]);
    }),
    invalidate: vi.fn(async (serverName: string) => {
      manifests.delete(serverName);
      cache.invalidated.push(serverName);
    }),
  };
  return cache;
}

interface FakeServer {
  adapter: McpPort;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connectServer: ReturnType<typeof vi.fn>;
  serverName: string;
}

/** 每个 pool entry 一个 adapter；connect 可被闸门挡住或返回失败。 */
function createServerFactory(options: {
  tools: Record<string, McpToolDescriptor[]>;
  connectGate?: Promise<void>;
  connectStatus?: McpServerStatus["status"];
  callGate?: () => Promise<void>;
}) {
  const created: FakeServer[] = [];
  const createAdapter = ({ serverName }: { serverName: string }): McpPort => {
    let status: McpServerStatus = {
      status: "connecting",
      toolCount: 0,
      transport: "stdio",
      updatedAt: new Date(0).toISOString(),
    };
    const connectServer = vi.fn(async () => {
      await options.connectGate;
      status = {
        ...status,
        status: options.connectStatus ?? "connected",
        toolCount: options.tools[serverName]?.length ?? 0,
        ...(options.connectStatus === "failed" ? { error: "spawn ENOENT" } : {}),
      };
      return status;
    });
    const callTool = vi.fn(async () => {
      await options.callGate?.();
      return { content: [{ text: `ok:${serverName}`, type: "text" }] };
    });
    const close = vi.fn(async () => undefined);
    const adapter = {
      callTool,
      close,
      connectConfiguredServers: vi.fn(),
      connectServer,
      disconnectServer: vi.fn(),
      listTools: vi.fn(async () =>
        status.status === "connected" ? [...(options.tools[serverName] ?? [])] : [],
      ),
      status: vi.fn(async () => ({ [serverName]: status })),
    } as unknown as McpPort;
    created.push({ adapter, callTool, close, connectServer, serverName });
    return adapter;
  };
  return { createAdapter, created };
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
};

describe("MCP 会话 lease：工具清单缓存与首次使用时启动", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("缓存命中时不启动进程，首次调用才连接并执行", async () => {
    const cached = [tool("docs", "create")];
    const cache = createMemoryCache({ docs: cached });
    const factory = createServerFactory({ tools: { docs: cached } });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });

    const snapshot = await lease.startConfiguredServers!({ docs: CONFIG });

    expect(factory.created).toHaveLength(0);
    expect(snapshot.tools).toEqual(cached);
    expect(snapshot.statuses.docs).toMatchObject({
      deferredStart: true,
      status: "disconnected",
      toolCount: 1,
    });
    const revisionBefore = lease.toolListRevision!();

    const result = await lease.callTool({ serverName: "docs", toolName: "create" });

    expect(result.content).toEqual([{ text: "ok:docs", type: "text" }]);
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]!.connectServer).toHaveBeenCalledOnce();
    expect((await lease.status()).docs?.status).toBe("connected");
    // 真实清单与缓存一致时不打扰 registry。
    expect(lease.toolListRevision!()).toBe(revisionBefore);
    await lease.close();
    await pool.close();
  });

  it("缓存未命中时后台连接不阻塞启动，连上后 revision 递增并写入缓存", async () => {
    const real = [tool("sheets", "read")];
    const cache = createMemoryCache();
    const gate = Promise.withResolvers<void>();
    const factory = createServerFactory({ connectGate: gate.promise, tools: { sheets: real } });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });

    const snapshot = await lease.startConfiguredServers!({ sheets: CONFIG });

    // 启动在连接完成前就返回：首个模型请求不等待 MCP。
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.statuses.sheets?.status).toBe("connecting");
    expect(snapshot.toolListRevision).toBe(0);
    gate.resolve();
    await vi.waitFor(async () => expect(await lease.listTools()).toEqual(real));
    expect(lease.toolListRevision!()).toBeGreaterThan(0);
    await vi.waitFor(() => expect(cache.manifests.get("sheets")).toEqual(real));
    await lease.close();
    await pool.close();
  });

  it("真实清单与缓存不一致时以真实清单为准并递增 revision", async () => {
    const cached = [tool("pdf", "render", "old description")];
    const real = [tool("pdf", "render", "new description"), tool("pdf", "merge")];
    const cache = createMemoryCache({ pdf: cached });
    const factory = createServerFactory({ tools: { pdf: real } });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });
    await lease.startConfiguredServers!({ pdf: CONFIG });
    const revisionBefore = lease.toolListRevision!();

    await lease.callTool({ serverName: "pdf", toolName: "render" });

    expect(lease.toolListRevision!()).toBeGreaterThan(revisionBefore);
    expect(await lease.listTools()).toEqual(real);
    await vi.waitFor(() => expect(cache.manifests.get("pdf")).toEqual(real));
    await lease.close();
    await pool.close();
  });

  it("首次启动失败返回结构化错误、删除缓存，并让工具从下一步起移出", async () => {
    const cached = [tool("slides", "build")];
    const cache = createMemoryCache({ slides: cached });
    const factory = createServerFactory({ connectStatus: "failed", tools: { slides: cached } });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });
    await lease.startConfiguredServers!({ slides: CONFIG });
    const revisionBefore = lease.toolListRevision!();

    const failure = await lease
      .callTool({ serverName: "slides", toolName: "build" })
      .then(() => undefined, (error: unknown) => error as Error & { code?: string });

    expect(failure?.code).toBe(MCP_SERVER_START_FAILED_ERROR_CODE);
    expect(failure?.message).toContain("slides");
    expect(failure?.message).toContain("spawn ENOENT");
    expect(cache.invalidated).toEqual(["slides"]);
    expect(lease.toolListRevision!()).toBeGreaterThan(revisionBefore);
    expect(await lease.listTools()).toEqual([]);
    await lease.close();
    await pool.close();
  });

  it("并发调用共享一次启动；调用方取消只结束自己的等待", async () => {
    const cached = [tool("docs", "create")];
    const cache = createMemoryCache({ docs: cached });
    const gate = Promise.withResolvers<void>();
    const factory = createServerFactory({ connectGate: gate.promise, tools: { docs: cached } });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });
    await lease.startConfiguredServers!({ docs: CONFIG });
    const controller = new AbortController();

    const cancelled = lease.callTool(
      { serverName: "docs", toolName: "create" },
      { signal: controller.signal },
    );
    const waiting = lease.callTool({ serverName: "docs", toolName: "create" });
    await flush();
    controller.abort(new Error("turn cancelled"));
    await expect(cancelled).rejects.toThrow("turn cancelled");
    // 启动期间仍报告缓存工具，避免其它刷新把它们提前移出 registry。
    expect(await lease.listTools()).toEqual(cached);
    gate.resolve();
    await expect(waiting).resolves.toMatchObject({ content: [{ text: "ok:docs" }] });
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]!.connectServer).toHaveBeenCalledOnce();
    await lease.close();
    await pool.close();
  });

  it("会话关闭时首次连接的等待立即结束，之后不再创建连接", async () => {
    const cached = [tool("docs", "create"), tool("pdf", "render")];
    const cache = createMemoryCache({
      docs: [cached[0]!],
      pdf: [cached[1]!],
    });
    const gate = Promise.withResolvers<void>();
    const factory = createServerFactory({
      connectGate: gate.promise,
      tools: { docs: [cached[0]!], pdf: [cached[1]!] },
    });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });
    await lease.startConfiguredServers!({ docs: CONFIG, pdf: CONFIG });

    const pending = lease.callTool({ serverName: "docs", toolName: "create" });
    await flush();
    await lease.close();
    await expect(pending).rejects.toThrow("MCP connection lease is closed");
    await expect(lease.callTool({ serverName: "pdf", toolName: "render" })).rejects.toThrow(
      "MCP connection lease is closed",
    );
    gate.resolve();
    await flush();
    // 只有关闭前已发起的那一个连接；它随引用归零被关闭，不泄漏到其它会话。
    expect(factory.created).toHaveLength(1);
    await vi.waitFor(() => expect(factory.created[0]!.close).toHaveBeenCalled());
    expect(cache.invalidated).toEqual([]);
    await pool.close();
  });

  it("会话启动遥测在后台连接结束后上报，待首次使用的 server 不计为失败", async () => {
    const events: Array<Record<string, unknown>> = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device",
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    const cache = createMemoryCache({ docs: [tool("docs", "create")] });
    const factory = createServerFactory({
      tools: { docs: [tool("docs", "create")], sheets: [tool("sheets", "read")] },
    });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      telemetry,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });

    await lease.startConfiguredServers!({ docs: CONFIG, sheets: CONFIG });

    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          configuredCount: 2,
          connectedCount: 1,
          failedCount: 0,
          kind: "session_startup",
          processCount: 1,
        }),
      ),
    );
    expect(events.filter((event) => event.kind === "session_startup")).toHaveLength(1);
    await lease.close();
    await pool.close();
  });
});

describe("MCP 会话 lease：闲置回收", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function startedLease(options: { callGate?: () => Promise<void> } = {}) {
    const cached = [tool("docs", "create")];
    const cache = createMemoryCache({ docs: cached });
    const factory = createServerFactory({
      tools: { docs: cached },
      ...(options.callGate ? { callGate: options.callGate } : {}),
    });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      sessionIdleReclaimMs: IDLE_MS,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });
    await lease.startConfiguredServers!({ docs: CONFIG });
    return { cache, cached, factory, lease, pool };
  }

  it("闲置 10 分钟后关闭进程并回到待首次使用，下一次调用经同一路径重启", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cached, factory, lease, pool } = await startedLease();
    await lease.callTool({ serverName: "docs", toolName: "create" });
    expect(factory.created).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
    expect(factory.created[0]!.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(factory.created[0]!.close).toHaveBeenCalledOnce());

    expect((await lease.status()).docs).toMatchObject({ deferredStart: true });
    // 工具仍按清单保留：registry 不需要变化。
    expect(await lease.listTools()).toEqual(cached);

    await lease.callTool({ serverName: "docs", toolName: "create" });
    expect(factory.created).toHaveLength(2);
    expect((await lease.status()).docs?.status).toBe("connected");
    await lease.close();
    await pool.close();
  });

  it("在途调用期间不回收，调用结束后重新计时", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const release = Promise.withResolvers<void>();
    let holdCall = false;
    const { factory, lease, pool } = await startedLease({
      callGate: async () => {
        if (holdCall) await release.promise;
      },
    });
    await lease.callTool({ serverName: "docs", toolName: "create" });
    holdCall = true;
    const longCall = lease.callTool({ serverName: "docs", toolName: "create" });

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(factory.created[0]!.close).not.toHaveBeenCalled();

    release.resolve();
    await longCall;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);
    await vi.waitFor(() => expect(factory.created[0]!.close).toHaveBeenCalledOnce());
    await lease.close();
    await pool.close();
  });

  it("MCP App 页面仍连接时不回收", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { factory, lease, pool } = await startedLease();
    await lease.callTool({ serverName: "docs", toolName: "create" });
    const off = lease.onAppConnectionInvalidated!("docs", () => undefined);

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(factory.created[0]!.close).not.toHaveBeenCalled();

    off();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);
    await vi.waitFor(() => expect(factory.created[0]!.close).toHaveBeenCalledOnce());
    await lease.close();
    await pool.close();
  });

  // 有状态 server（如 node_repl 的 REPL 变量）由宿主在配置上声明 idleReclaim: false：
  // 仍然首次使用时才启动，但闲置窗口过后不回收；无状态 server 照常回收。
  it("声明有状态的 server 跨过闲置窗口仍保持连接，无状态 server 被回收", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tools = { docs: [tool("docs", "create")], repl: [tool("repl", "js")] };
    const cache = createMemoryCache(tools);
    const factory = createServerFactory({ tools });
    const pool = createMcpConnectionPool({
      createAdapter: factory.createAdapter,
      idleGraceMs: 0,
      sessionIdleReclaimMs: IDLE_MS,
      toolManifestCache: cache,
    });
    const lease = pool.acquireLease({ leaseId: "s1", sessionId: "s1" });
    await lease.startConfiguredServers!({ docs: CONFIG, repl: { ...CONFIG, idleReclaim: false } });
    // 有状态也保留首次使用时启动：登记阶段不启动任何进程。
    expect(factory.created).toHaveLength(0);
    expect((await lease.status()).repl).toMatchObject({ deferredStart: true });

    await lease.callTool({ serverName: "repl", toolName: "js" });
    await lease.callTool({ serverName: "docs", toolName: "create" });
    const repl = factory.created.find((server) => server.serverName === "repl")!;
    const docs = factory.created.find((server) => server.serverName === "docs")!;

    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    await vi.waitFor(() => expect(docs.close).toHaveBeenCalledOnce());
    expect(repl.close).not.toHaveBeenCalled();
    const statuses = await lease.status();
    expect(statuses.docs).toMatchObject({ deferredStart: true });
    expect(statuses.repl?.status).toBe("connected");
    // 有状态 server 不留闲置计时器。
    expect(vi.getTimerCount()).toBe(0);

    await lease.callTool({ serverName: "repl", toolName: "js" });
    expect(repl.connectServer).toHaveBeenCalledOnce();
    await lease.close();
    await pool.close();
  });

  it("会话关闭清除闲置计时器，之后不再回收或重启", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { factory, lease, pool } = await startedLease();
    await lease.callTool({ serverName: "docs", toolName: "create" });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await lease.close();
    await vi.waitFor(() => expect(factory.created[0]!.close).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(factory.created).toHaveLength(1);
    await pool.close();
  });
});
