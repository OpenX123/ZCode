import type {
  Logger,
  McpConnectOptions,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { MCP_SERVER_START_FAILED_ERROR_CODE } from "@zcode/contracts";
import type {
  McpLazyStartTrigger,
  McpLeaseServerLifecycle,
  McpLeaseServerLifecycleDeps,
} from "./contract.js";
import { LeaseIdleReclaimer } from "./idle-reclaimer.js";
import { toolManifestSignature } from "./tool-manifest-cache.js";

/**
 * 会话 MCP lease 的 server 生命周期（规则见 docs/design/v2/mcp.md
 * 「会话启动：工具清单缓存与首次使用时启动」）。
 *
 * 修复原因：会话首个模型请求过去等待全部 MCP server 连接（1.0.5：p50 2.5s / p90 4.5s，最大 7.4s；
 * 4 个默认启用的 office 插件各自启动 YCode.exe 并加载 14.5MB bundle）。现在命中工具清单缓存的
 * server 只登记、首次实际使用才连接；未命中的后台连接，连上后通过 revision 让 runtime 在下一次
 * 模型步骤加入工具。本类只拥有"待首次使用 / 启动中"登记与闲置计时，连接本身仍由 lease 创建与释放。
 */
export function createMcpLeaseServerLifecycle(
  deps: McpLeaseServerLifecycleDeps,
): McpLeaseServerLifecycle {
  return new LeaseServerLifecycle(deps);
}

interface DeferredServer {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  registeredAt: string;
  tools: McpToolDescriptor[];
}

interface PendingStart {
  promise: Promise<void>;
  /** 启动期间继续对外报告缓存工具，避免其它 server 触发的刷新把它们提前移出 registry。 */
  tools: McpToolDescriptor[];
}

const LEASE_CLOSED_MESSAGE = "MCP connection lease is closed";

class LeaseServerLifecycle implements McpLeaseServerLifecycle {
  private readonly deferred = new Map<string, DeferredServer>();
  private readonly starting = new Map<string, PendingStart>();
  private readonly closeController = new AbortController();
  private readonly idleReclaimer: LeaseIdleReclaimer;
  private readonly logger?: Logger;
  private revision = 0;

  constructor(private readonly deps: McpLeaseServerLifecycleDeps) {
    this.logger = deps.logger;
    this.idleReclaimer = new LeaseIdleReclaimer(
      deps.idleReclaimMs ?? 0,
      (serverName, isStillIdle) => deps.onIdle?.(serverName, isStillIdle),
      (serverName) => deps.isIdleReclaimable?.(serverName) ?? true,
    );
  }

  /** 叠加到 lease 的 toolListRevision：后台连接结束、清单漂移、首次启动失败都会递增。 */
  get toolListRevision(): number {
    return this.revision;
  }

  private get closed(): boolean {
    return this.closeController.signal.aborted;
  }

  /**
   * 登记启用的 server：读缓存，命中的推迟到首次使用，未命中的后台连接。
   * 只等待缓存读取；返回的 settled 在全部后台连接结束后 resolve，供启动遥测使用。
   */
  async register(
    servers: ReadonlyArray<readonly [string, McpServerConfig]>,
    connectOptions: McpConnectOptions,
  ): Promise<{ backgroundNames: string[]; deferredNames: string[]; settled: Promise<void> }> {
    const lookups = await Promise.all(
      servers.map(async ([serverName, config]) => ({
        config,
        serverName,
        tools: await this.deps.cache.read(serverName, config),
      })),
    );
    const backgroundNames: string[] = [];
    const deferredNames: string[] = [];
    const background: Promise<void>[] = [];
    for (const { config, serverName, tools } of lookups) {
      if (this.closed) break;
      const logContext = this.logContext(serverName);
      if (tools) {
        this.deferred.set(serverName, {
          config,
          connectOptions,
          registeredAt: new Date().toISOString(),
          tools,
        });
        deferredNames.push(serverName);
        this.logger?.info("MCP tool manifest cache hit", {
          ...logContext,
          event: "mcp.manifest_cache.hit",
          status: "completed",
          toolCount: tools.length,
        });
        continue;
      }
      backgroundNames.push(serverName);
      this.logger?.info("MCP tool manifest cache miss", {
        ...logContext,
        event: "mcp.manifest_cache.miss",
        status: "started",
      });
      background.push(this.startInBackground(serverName, config, connectOptions));
    }
    return {
      backgroundNames,
      deferredNames,
      settled: Promise.allSettled(background).then(() => undefined),
    };
  }

  deferredNames(): string[] {
    return [...this.deferred.keys()];
  }

  /** 待首次使用或启动中的 server 对外报告的缓存工具。 */
  cachedTools(serverName: string): McpToolDescriptor[] | undefined {
    return this.deferred.get(serverName)?.tools ?? this.starting.get(serverName)?.tools;
  }

  deferredStatus(serverName: string): McpServerStatus | undefined {
    const server = this.deferred.get(serverName);
    if (!server) return undefined;
    return {
      deferredStart: true,
      status: "disconnected",
      toolCount: server.tools.length,
      transport: server.config.type,
      updatedAt: server.registeredAt,
    };
  }

  /**
   * 一次实际使用：期间暂停闲置计时；待首次使用的 server 先单飞连接。调用方的 signal 与 lease
   * 关闭只结束本次等待，已发起的连接继续由 lease 的引用计数与空闲回收管理，不会漏到其它会话。
   */
  async use<T>(
    serverName: string,
    trigger: McpLazyStartTrigger,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const end = this.idleReclaimer.begin(serverName);
    try {
      await this.ensureStarted(serverName, trigger, signal);
      return await run();
    } finally {
      end();
    }
  }

  connected(serverName: string): void {
    this.idleReclaimer.arm(serverName);
  }

  /** server 被释放、换配置或显式连接/断开：丢弃待首次使用的登记并取消闲置计时。 */
  forget(serverName: string): void {
    this.idleReclaimer.cancel(serverName);
    if (this.deferred.delete(serverName)) this.revision += 1;
  }

  /**
   * 闲置回收后回到"待首次使用"：工具沿用回收前的真实清单，registry 不需要变化，因此不递增
   * revision；下一次使用经 ensureStarted 重新连接。
   */
  defer(
    serverName: string,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
    tools: McpToolDescriptor[],
    // 被释放连接已累计的 list_changed 次数，并入本计数以保持 lease revision 单调。
    releasedRevision = 0,
  ): void {
    if (this.closed) return;
    this.revision += releasedRevision;
    this.deferred.set(serverName, {
      config,
      connectOptions,
      registeredAt: new Date().toISOString(),
      tools,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closeController.abort(new Error(LEASE_CLOSED_MESSAGE));
    this.idleReclaimer.close();
    this.deferred.clear();
  }

  private async ensureStarted(
    serverName: string,
    trigger: McpLazyStartTrigger,
    signal?: AbortSignal,
  ): Promise<void> {
    // lease 关闭后不再创建新连接；在途的首次连接由下面的等待以关闭原因结束。
    if (this.closed && !this.starting.has(serverName)) throw new Error(LEASE_CLOSED_MESSAGE);
    const pending = this.starting.get(serverName) ?? this.beginStart(serverName, trigger);
    if (!pending) return;
    await waitUntilSettledOrAborted(pending.promise, [signal, this.closeController.signal]);
  }

  private startInBackground(
    serverName: string,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    return this.deps
      .acquire(serverName, config, connectOptions)
      .then(
        (status) => {
          this.logger?.info("MCP background start completed", {
            ...this.logContext(serverName),
            durationMs: Date.now() - startedAt,
            event: "mcp.background_start.completed",
            mcpConnectionState: status.status,
            status: "completed",
            toolCount: status.toolCount,
          });
        },
        (error: unknown) => {
          if (this.closed) return;
          this.logger?.warn("MCP background start failed", {
            ...this.logContext(serverName),
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            event: "mcp.background_start.failed",
            status: "failed",
          });
        },
      )
      .finally(() => {
        // 连接结束后 runtime 在下一次模型步骤重新 listTools，新工具从那一步起可见。
        this.revision += 1;
      });
  }

  private beginStart(serverName: string, trigger: McpLazyStartTrigger): PendingStart | undefined {
    const server = this.deferred.get(serverName);
    if (!server) return undefined;
    this.deferred.delete(serverName);
    const startedAt = Date.now();
    const logContext = { ...this.logContext(serverName), trigger };
    this.logger?.info("MCP lazy start started", {
      ...logContext,
      event: "mcp.lazy_start.started",
      status: "started",
    });
    const promise = (async () => {
      const status = await this.deps.acquire(serverName, server.config, server.connectOptions);
      if (status.status !== "connected") throw createStartError(serverName, status);
      const tools = await this.deps.readServerTools(serverName);
      const manifestChanged = toolManifestSignature(tools) !== toolManifestSignature(server.tools);
      if (manifestChanged) {
        // 真实清单为准：registry 从下一次模型步骤起改用真实清单（lease 已在连接时刷新缓存）。
        this.revision += 1;
        this.logger?.info("MCP tool manifest drifted from cache", {
          ...logContext,
          cachedToolCount: server.tools.length,
          event: "mcp.manifest_cache.drift",
          status: "completed",
          toolCount: tools.length,
        });
      }
      this.logger?.info("MCP lazy start completed", {
        ...logContext,
        durationMs: Date.now() - startedAt,
        event: "mcp.lazy_start.completed",
        manifestChanged,
        status: "completed",
        toolCount: tools.length,
      });
    })()
      .catch(async (error: unknown) => {
        if (this.closed) throw error;
        // 失败的 server 不再提供工具：下一次模型步骤起从 registry 移除，与原先启动失败不注册一致。
        this.revision += 1;
        this.logger?.warn("MCP lazy start failed", {
          ...logContext,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.lazy_start.failed",
          status: "failed",
        });
        const pendingAuthorization =
          error instanceof Error && (error as McpServerStartError).mcpConnectionState === "connecting";
        // 仍在等待授权的 server 清单本身没有问题；其余失败删除缓存，下个会话改走后台连接。
        if (!pendingAuthorization) await this.deps.cache.invalidate(serverName, server.config);
        throw error;
      })
      .finally(() => {
        this.starting.delete(serverName);
      });
    // 首次使用方可能已因取消离开；连接结果仍需收尾，不能变成未处理的拒绝。
    promise.catch(() => undefined);
    const pending = { promise, tools: server.tools };
    this.starting.set(serverName, pending);
    return pending;
  }

  private logContext(serverName: string): Record<string, unknown> {
    return {
      mcpServerName: serverName,
      ...(this.deps.sessionId ? { sessionId: this.deps.sessionId } : {}),
    };
  }
}

interface McpServerStartError extends Error {
  code: string;
  failureKind?: McpServerStatus["failureKind"];
  mcpConnectionState: McpServerStatus["status"];
  serverName: string;
}

function createStartError(serverName: string, status: McpServerStatus): McpServerStartError {
  const reason =
    status.status === "connecting"
      ? status.authorization
        ? "waiting for OAuth authorization"
        : "connection did not finish"
      : (status.error ?? status.status);
  return Object.assign(new Error(`MCP server ${serverName} failed to start: ${reason}`), {
    code: MCP_SERVER_START_FAILED_ERROR_CODE,
    ...(status.failureKind ? { failureKind: status.failureKind } : {}),
    mcpConnectionState: status.status,
    serverName,
  });
}

/** 等待共享的启动任务；任一 signal 中止时以其 reason 结束等待，不取消底层任务。 */
function waitUntilSettledOrAborted(
  task: Promise<void>,
  signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<void> {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const aborted = active.find((signal) => signal.aborted);
  if (aborted) return Promise.reject(abortReason(aborted));
  if (active.length === 0) return task;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      for (const signal of active) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (event: Event) => {
      cleanup();
      rejectPromise(abortReason(event.target as AbortSignal));
    };
    for (const signal of active) signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      () => {
        cleanup();
        resolvePromise();
      },
      (error: unknown) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
