import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import {
  createMcpLeaseServerLifecycle,
  type McpLazyStartTrigger,
  type McpToolManifestCache,
} from "./lazy-start/index.js";
import type { McpTelemetryTracker } from "./telemetry.js";

const DEFAULT_IDLE_GRACE_MS = 30_000;
// 会话里已连接、无在途请求的 server 闲置这么久后由 lease 关闭，回到"待首次使用"。
const DEFAULT_SESSION_IDLE_RECLAIM_MS = 10 * 60_000;
const LEASE_CLOSED_MESSAGE = "MCP connection lease is closed";

export interface CreateMcpAdapterForPoolInput {
  connectionContext: McpConnectionContext;
  config: McpServerConfig;
  serverName: string;
  workingDirectory?: string;
}

export interface McpConnectionContext {
  mcpConnectionId: string;
  mcpIsolation: "session" | "workspace";
  sessionId?: string;
  workspaceKey?: string;
}

export interface McpConnectionPoolOptions {
  createAdapter(input: CreateMcpAdapterForPoolInput): McpPort;
  idleGraceMs?: number;
  /**
   * 会话 lease 的闲置回收窗口（需配合 toolManifestCache；<=0 关闭）。设置页等无 sessionId 的
   * lease 不回收，避免状态轮询把被回收的 server 显示成断开。
   */
  sessionIdleReclaimMs?: number;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  /**
   * 工具清单缓存。提供时：任一连接成功都用真实 tools/list 刷新缓存；会话 lease 支持
   * startConfiguredServers 的非阻塞启动。缺省时 startConfiguredServers 退化为阻塞连接。
   */
  toolManifestCache?: McpToolManifestCache;
}

export interface McpConnectionPool {
  acquireLease(options?: { leaseId?: string; sessionId?: string }): McpPort;
  close(): Promise<void>;
  stats(): { activeConnections: number; pendingCloseConnections: number };
}

interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  connecting: Promise<McpServerStatus>;
  key: string;
  refs: Set<string>;
  /** 同一 entry 的并发存活校验共享一次探测，避免重复 ping / 重复重连。 */
  revalidating?: Promise<void>;
  serverName: string;
}

export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const entries = new Map<string, PoolEntry>();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let leaseSequence = 0;

  const closeEntry = async (entry: PoolEntry): Promise<void> => {
    const startedAt = Date.now();
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    try {
      await entry.adapter.close();
      logger?.info("MCP pooled connection closed", {
        ...entry.connectionContext,
        durationMs: Date.now() - startedAt,
        event: "mcp.pool.connection.closed",
        mcpServerName: entry.serverName,
        status: "completed",
      });
    } catch (error) {
      logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.pool.connection.close.failed",
        mcpServerName: entry.serverName,
      });
    } finally {
      options.telemetry?.unregisterConnection({
        connectionId: entry.connectionContext.mcpConnectionId,
      });
    }
  };

  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      void closeEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) void closeEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  // 设置页的 mcpPort 是进程级的 `protocol-settings` lease，connectionKey 只由
  // serverName + leaseId + config 组成，配置没变时每次 mcp/list 都命中同一个 entry 并直接返回
  // 首次连接那个早已 resolve 的 promise——不重连、不探测、不打日志。HTTP/SSE MCP 被停掉又不会
  // 派发 onclose，于是设置页永远显示"已连接并可用"，点多少次刷新都不变。
  // 这里在显式要求 revalidate 时先确认连接仍然存活，已死则在同一个 entry 上原地重连
  // （保持 entry 身份，其他共享该连接的 lease 不会被打断成 "not leased"）。
  const revalidateEntry = async (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> => {
    if (entry.revalidating) {
      await entry.revalidating;
      return;
    }
    const run = (async () => {
      const connected = await entry.connecting.then(
        () => true,
        () => false,
      );
      const state = connected
        ? (await entry.adapter.status())[entry.serverName]?.status
        : undefined;
      // 进行中的握手（含 OAuth 待授权）和显式停用/待信任状态不打扰：
      // 重连会作废浏览器里已打开的授权 URL 和 PKCE/state。
      if (state === "connecting" || state === "disabled" || state === "untrusted") {
        return;
      }
      if (state === "connected") {
        const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
        if (alive) {
          logger?.debug("MCP pooled connection revalidated", {
            ...entry.connectionContext,
            event: "mcp.pool.connection.revalidated",
            mcpServerName: entry.serverName,
            status: "completed",
          });
          return;
        }
      }
      logger?.warn("MCP pooled connection is stale; reconnecting", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.stale",
        mcpConnectionState: state ?? "unknown",
        mcpServerName: entry.serverName,
        status: "started",
      });
      entry.connecting = entry.adapter.connectServer(entry.serverName, config, connectOptions);
      // 失败由 status()/调用方 await entry.connecting 表达，这里不重复冒泡。
      await entry.connecting.catch(() => undefined);
    })();
    entry.revalidating = run.finally(() => {
      entry.revalidating = undefined;
    });
    await entry.revalidating;
  };

  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (closed) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, string>();
    const configuredServers = new Map<string, McpServerConfig>();
    const appListeners = new Map<string, Set<{ listener: () => void; off: () => void }>>();
    const invalidateApps = (serverName: string) => {
      const watchers = appListeners.get(serverName);
      appListeners.delete(serverName);
      for (const watcher of watchers ?? []) {
        watcher.off();
        watcher.listener();
      }
    };
    let leaseClosed = false;
    let sessionStartupReported = false;
    // 最近一次 acquire 的配置与连接选项：闲置回收后按同一配置回到"待首次使用"。
    const acquiredServers = new Map<
      string,
      { config: McpServerConfig; connectOptions: McpConnectOptions }
    >();

    /** replace 语义：记录本次配置，释放并丢弃不再配置的 server（含待首次使用的登记）。 */
    const reconcileConfiguredServers = (servers: Record<string, McpServerConfig>): void => {
      configuredServers.clear();
      for (const [serverName, config] of Object.entries(servers)) {
        configuredServers.set(serverName, config);
      }
      const configuredNames = new Set(Object.keys(servers));
      for (const serverName of [...leased.keys()]) {
        if (!configuredNames.has(serverName)) release(serverName);
      }
      for (const serverName of lifecycle?.deferredNames() ?? []) {
        if (!configuredNames.has(serverName)) lifecycle?.forget(serverName);
      }
    };

    const requireEntry = (serverName: string): PoolEntry => {
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string): void => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      lifecycle?.forget(serverName);
      invalidateApps(serverName);
      const entry = entries.get(key);
      if (!entry) return;
      if (!entry.refs.delete(leaseId)) return;
      options.telemetry?.releaseOwner({
        connectionId: entry.connectionContext.mcpConnectionId,
        ownerId: leaseId,
      });
      logger?.info("MCP connection lease released", {
        ...entry.connectionContext,
        event: "mcp.pool.lease.released",
        mcpLeaseId: leaseId,
        mcpServerName: serverName,
        refCount: entry.refs.size,
        ...(sessionId ? { sessionId } : {}),
      });
      if (entry.refs.size === 0) scheduleClose(entry);
    };

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      // 修复原因：首次使用时启动可能晚于会话关闭；关闭后再建 entry 会留下永远不释放的引用和进程。
      if (leaseClosed) throw new Error(LEASE_CLOSED_MESSAGE);
      // 显式连接（含后台与首次使用）接管该 server，不再报告缓存登记。
      lifecycle?.forget(serverName);
      acquiredServers.set(serverName, { config, connectOptions });
      const key = connectionKey({
        config,
        connectOptions,
        leaseId,
        serverName,
      });
      const previousKey = leased.get(serverName);
      let entry = entries.get(key);
      let ownerAdded = false;
      if (entry) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const previousRefCount = entry.refs.size;
        entry.refs.add(leaseId);
        ownerAdded = entry.refs.size !== previousRefCount;
        if (connectOptions.revalidate) {
          await revalidateEntry(entry, config, connectOptions);
        }
      } else {
        // 过去 pool、adapter 和 stdio PID 的日志彼此没有稳定关联键，无法从一个
        // session 追到实际 MCP 子进程。连接上下文在 entry 创建时固定，后续 lease 共用同一 ID。
        const connectionContext = createConnectionContext({
          config,
          connectOptions,
          sessionId,
        });
        options.telemetry?.registerConnection({
          connectionId: connectionContext.mcpConnectionId,
          isolation: connectionContext.mcpIsolation,
          serverName,
          ...(config.source ? { source: config.source.kind } : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
        entry = {
          adapter,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, connectOptions),
          key,
          refs: new Set([leaseId]),
          serverName,
        };
        entries.set(key, entry);
        ownerAdded = true;
        logger?.info("MCP pooled connection created", {
          ...connectionContext,
          event: "mcp.pool.connection.created",
          mcpServerName: serverName,
          transport: config.type,
        });
      }
      if (previousKey && previousKey !== key) {
        invalidateApps(serverName);
        const previous = entries.get(previousKey);
        if (previous) {
          if (previous.refs.delete(leaseId)) {
            options.telemetry?.releaseOwner({
              connectionId: previous.connectionContext.mcpConnectionId,
              ownerId: leaseId,
            });
            logger?.info("MCP connection lease released", {
              ...previous.connectionContext,
              event: "mcp.pool.lease.released",
              mcpLeaseId: leaseId,
              mcpServerName: serverName,
              refCount: previous.refs.size,
              ...(sessionId ? { sessionId } : {}),
            });
            if (previous.refs.size === 0) scheduleClose(previous);
          }
        }
      }
      leased.set(serverName, key);
      if (ownerAdded) {
        options.telemetry?.acquireOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      if (previousKey !== key) {
        // workspace 隔离连接会被多个 session 共享，不能把首个 session 记成唯一 owner；
        // 单独记录 lease 生命周期才能准确表达多对一关系。
        logger?.info("MCP connection lease acquired", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.acquired",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      const connectedEntry = entry;
      const status = await connectedEntry.connecting;
      if (status.status === "connected" && options.toolManifestCache) {
        // 任一连接成功都用真实 tools/list 刷新缓存；同内容不重复写盘，失败只记 warn。
        void readEntryServerTools(connectedEntry, serverName).then(
          (tools) => options.toolManifestCache?.write(serverName, config, tools),
          () => undefined,
        );
      }
      // 闲置窗口从连接完成起算；在途使用结束时重新计时。
      if (status.status === "connected" && leased.get(serverName) === key) {
        lifecycle?.connected(serverName);
      }
      return status;
    };

    /**
     * 闲置回收：到期时再确认仍由本 lease 持有、无在途请求、无 MCP App 连接且已连接，
     * 再释放连接并回到"待首次使用"。工具沿用真实清单，registry 不变；下一次使用重新连接。
     */
    const reclaimIdleServer = async (
      serverName: string,
      isStillIdle: () => boolean,
    ): Promise<void> => {
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      const acquired = acquiredServers.get(serverName);
      if (leaseClosed || !entry || !acquired || !lifecycle) return;
      if ((appListeners.get(serverName)?.size ?? 0) > 0) {
        // MCP App 页面仍连接着该 server：不回收，下一个窗口再看。
        lifecycle.connected(serverName);
        return;
      }
      const status = (await entry.adapter.status())[serverName];
      if (status?.status !== "connected") return;
      const tools = await readEntryServerTools(entry, serverName).catch(() => undefined);
      // await 期间可能有新调用、换连接或会话关闭：任一变化都放弃本次回收。
      if (
        !tools ||
        leaseClosed ||
        leased.get(serverName) !== key ||
        !isStillIdle() ||
        (appListeners.get(serverName)?.size ?? 0) > 0
      ) {
        return;
      }
      void options.toolManifestCache?.write(serverName, acquired.config, tools);
      // 释放后该 adapter 的 list_changed 计数不再计入 lease revision；并入后 revision 仍单调。
      const releasedRevision = entry.adapter.toolListRevision?.() ?? 0;
      release(serverName);
      lifecycle.defer(serverName, acquired.config, acquired.connectOptions, tools, releasedRevision);
      logger?.info("MCP idle server reclaimed", {
        ...entry.connectionContext,
        event: "mcp.idle_reclaim.closed",
        idleMs: sessionIdleReclaimMs,
        mcpServerName: serverName,
        status: "completed",
        toolCount: tools.length,
        ...(sessionId ? { sessionId } : {}),
      });
    };

    const readEntryServerTools = async (
      entry: PoolEntry,
      serverName: string,
    ): Promise<McpToolDescriptor[]> =>
      (await entry.adapter.listTools()).filter((tool) => tool.serverName === serverName);

    // 只有会话 lease 闲置回收；设置页 lease 的状态轮询不能把被回收的 server 显示成断开。
    const sessionIdleReclaimMs = sessionId
      ? (options.sessionIdleReclaimMs ?? DEFAULT_SESSION_IDLE_RECLAIM_MS)
      : 0;
    const lifecycle = options.toolManifestCache
      ? createMcpLeaseServerLifecycle({
          acquire,
          cache: options.toolManifestCache,
          idleReclaimMs: sessionIdleReclaimMs,
          logger,
          onIdle: (serverName, isStillIdle) => {
            void reclaimIdleServer(serverName, isStillIdle).catch((error: unknown) => {
              logger?.warn("MCP idle reclaim failed", {
                error: error instanceof Error ? error.message : String(error),
                event: "mcp.idle_reclaim.failed",
                mcpServerName: serverName,
                status: "failed",
                ...(sessionId ? { sessionId } : {}),
              });
            });
          },
          readServerTools: async (serverName) => {
            const key = leased.get(serverName);
            const entry = key ? entries.get(key) : undefined;
            return entry ? await readEntryServerTools(entry, serverName) : [];
          },
          ...(sessionId ? { sessionId } : {}),
        })
      : undefined;

    /** 一次对 server 的实际使用：待首次使用的先单飞连接，期间不计闲置，再交给原有 entry 路径。 */
    const withServer = async <T>(
      serverName: string,
      trigger: McpLazyStartTrigger,
      signal: AbortSignal | undefined,
      run: (entry: PoolEntry) => Promise<T>,
    ): Promise<T> =>
      lifecycle
        ? await lifecycle.use(serverName, trigger, () => run(requireEntry(serverName)), signal)
        : await run(requireEntry(serverName));

    const collectSnapshot = async (): Promise<McpConnectionSnapshot> => {
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, key] of leased) {
        const entry = entries.get(key);
        if (!entry) continue;
        const status = (await entry.adapter.status())[serverName];
        if (status) statuses[serverName] = status;
        // 首次使用时连接期间继续报告缓存工具，连上后改为真实工具。
        tools.push(...(lifecycle?.cachedTools(serverName) ?? (await entry.adapter.listTools())));
      }
      for (const serverName of lifecycle?.deferredNames() ?? []) {
        const status = lifecycle?.deferredStatus(serverName);
        if (status) statuses[serverName] = status;
        tools.push(...(lifecycle?.cachedTools(serverName) ?? []));
      }
      return { statuses, tools };
    };

    const reportSessionStartup = (statuses: Record<string, McpServerStatus>): void => {
      if (!sessionId) return;
      const enabledServers = [...configuredServers].filter(
        ([, config]) => config.enabled !== false,
      );
      const connectedCount = enabledServers.filter(
        ([serverName]) => statuses[serverName]?.status === "connected",
      ).length;
      // 待首次使用的 server 既未连接也不算失败。
      const deferredCount = enabledServers.filter(
        ([serverName]) => statuses[serverName]?.deferredStart === true,
      ).length;
      options.telemetry?.recordSessionStartup({
        configuredCount: enabledServers.length,
        connectedCount,
        failedCount: Math.max(0, enabledServers.length - connectedCount - deferredCount),
        processCount: enabledServers.filter(
          ([serverName, config]) =>
            config.type === "stdio" && statuses[serverName]?.status === "connected",
        ).length,
        sessionId,
      });
    };

    const snapshot = async (): Promise<McpConnectionSnapshot> => {
      const revision = toolListRevision();
      const collected = await collectSnapshot();
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        reportSessionStartup(collected.statuses);
      }
      return { ...collected, toolListRevision: revision };
    };

    function toolListRevision(): number {
      let revision = lifecycle?.toolListRevision ?? 0;
      for (const key of new Set(leased.values())) {
        revision += entries.get(key)?.adapter.toolListRevision?.() ?? 0;
      }
      return revision;
    }

    const connectConfiguredServers = async (
      servers: Record<string, McpServerConfig>,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpConnectionSnapshot> => {
      reconcileConfiguredServers(servers);
      await Promise.all(
        Object.entries(servers).map(([serverName, config]) =>
          acquire(serverName, config, connectOptions),
        ),
      );
      return await snapshot();
    };

    return {
      async waitForAppConnection(serverName) {
        // MCP App 首次签发凭证是对 server 的实际使用；启动失败按"连接不可用"返回 null。
        if (lifecycle?.deferredStatus(serverName)) {
          const started = await lifecycle
            .use(serverName, "app_connection", async () => true)
            .catch(() => false);
          if (!started) return null;
        }
        const key = leased.get(serverName);
        if (!key) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        const connecting = entry.connecting;
        await connecting;
        const source = entry.adapter.waitForAppConnection
          ? await entry.adapter.waitForAppConnection(serverName)
          : (entry.adapter.appConnectionSnapshot?.(serverName) ?? null);
        // 共享连接可能仍被其它会话持有；等待结束不能复活已释放或换源的本会话 lease。
        return !leaseClosed &&
          leased.get(serverName) === key &&
          entries.get(key) === entry &&
          entry.connecting === connecting
          ? source
          : null;
      },
      appConnectionSnapshot(serverName) {
        const key = leased.get(serverName);
        return key ? (entries.get(key)?.adapter.appConnectionSnapshot?.(serverName) ?? null) : null;
      },
      onAppConnectionInvalidated(serverName, listener) {
        const entry = requireEntry(serverName);
        const watchers = appListeners.get(serverName) ?? new Set();
        const watcher = {
          listener,
          off: entry.adapter.onAppConnectionInvalidated?.(serverName, listener) ?? (() => {}),
        };
        watchers.add(watcher);
        appListeners.set(serverName, watchers);
        return () => {
          watcher.off();
          watchers.delete(watcher);
          if (!watchers.size) appListeners.delete(serverName);
        };
      },
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        return await withServer(request.serverName, "tool_call", callOptions?.signal, (entry) =>
          entry.adapter.callTool(request, callOptions),
        );
      },
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        return await withServer(request.serverName, "resource", callOptions?.signal, async (entry) => {
          const adapter = entry.adapter;
          if (!adapter.readResource) {
            throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
          }
          return await adapter.readResource(request, callOptions);
        });
      },
      // 资源列表与订阅经同一 entry 的 adapter；登记表在 adapter（连接层）里，多 session 共享。
      async listResources(request, callOptions) {
        return await withServer(request.serverName, "resource", callOptions?.signal, async (entry) => {
          const adapter = entry.adapter;
          if (!adapter.listResources) {
            throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
          }
          return await adapter.listResources(request, callOptions);
        });
      },
      async listResourceTemplates(request, callOptions) {
        return await withServer(request.serverName, "resource", callOptions?.signal, async (entry) => {
          const adapter = entry.adapter;
          if (!adapter.listResourceTemplates) {
            throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
          }
          return await adapter.listResourceTemplates(request, callOptions);
        });
      },
      async subscribeResource(request, callOptions) {
        await withServer(request.serverName, "resource", callOptions?.signal, async (entry) => {
          const adapter = entry.adapter;
          if (!adapter.subscribeResource) {
            throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
          }
          await adapter.subscribeResource(request, callOptions);
        });
      },
      async unsubscribeResource(request, callOptions) {
        // 从未启动的 server 没有任何订阅，不为退订而启动它。
        if (lifecycle?.deferredStatus(request.serverName)) return;
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, callOptions);
      },
      async unsubscribeResourcesBySubscriber(prefix) {
        let released = 0;
        const seen = new Set<string>();
        for (const key of leased.values()) {
          if (seen.has(key)) continue;
          seen.add(key);
          const adapter = entries.get(key)?.adapter;
          if (adapter?.unsubscribeResourcesBySubscriber) {
            released += await adapter.unsubscribeResourcesBySubscriber(prefix);
          }
        }
        return released;
      },
      async close(): Promise<void> {
        if (leaseClosed) return;
        leaseClosed = true;
        // 先结束首次连接的等待方并清掉闲置计时器，再按原引用计数释放；在途连接沿空闲回收关闭。
        lifecycle?.close();
        for (const serverName of [...leased.keys()]) release(serverName);
      },
      connectConfiguredServers,
      async startConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        if (!lifecycle) return await connectConfiguredServers(servers, connectOptions);
        reconcileConfiguredServers(servers);
        const configured = Object.entries(servers);
        // 停用的 server 不启动进程，沿用原有收敛立即得到 disabled 状态。
        await Promise.all(
          configured
            .filter(([, config]) => config.enabled === false)
            .map(([serverName, config]) => acquire(serverName, config, connectOptions)),
        );
        // 启动遥测要在后台连接结束后才有真实的 connected / failed，快照阶段不上报。
        sessionStartupReported = true;
        const registered = await lifecycle.register(
          configured.filter(([, config]) => config.enabled !== false),
          connectOptions,
        );
        void registered.settled
          .then(async () => {
            if (!leaseClosed) reportSessionStartup((await collectSnapshot()).statuses);
          })
          .catch(() => undefined);
        return await snapshot();
      },
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        return await acquire(serverName, config, connectOptions);
      },
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        const deferredStatus = lifecycle?.deferredStatus(serverName);
        if (deferredStatus) {
          lifecycle?.forget(serverName);
          return {
            status: "disconnected",
            toolCount: 0,
            transport: deferredStatus.transport,
            updatedAt: new Date().toISOString(),
          };
        }
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        const status = entry ? (await entry.adapter.status())[serverName] : undefined;
        release(serverName);
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      toolListRevision,
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return {
    acquireLease,
    async close(): Promise<void> {
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(pending.map(closeEntry));
    },
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}

function createConnectionContext(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  sessionId?: string;
}): McpConnectionContext {
  const mcpIsolation = input.config.isolation === "workspace" ? "workspace" : "session";
  const workspaceKey = resolveWorkspaceKey(input.connectOptions);
  return {
    mcpConnectionId: randomUUID(),
    mcpIsolation,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(mcpIsolation === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

function resolveWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

function connectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  // 默认 session isolation；只有明确声明 workspace 的无状态 server 才允许跨 session 复用。
  const scope =
    input.config.isolation === "workspace"
      ? (resolveWorkspaceKey(input.connectOptions) ?? "")
      : input.leaseId;
  return [input.serverName, scope, stableStringify(input.config)].join("\u0000");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
