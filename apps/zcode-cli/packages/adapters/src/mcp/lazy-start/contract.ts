/**
 * cli-mcp-lazy-start 对外契约：会话 MCP lease 内 server 的"待首次使用 ⇄ 已连接 ⇄ 闲置回收"生命周期，
 * 以及持久化的工具清单缓存。唯一使用方是 MCP 连接池（adapters/src/mcp/pool.ts）；runtime 只经
 * McpPort 看到结果。规则见 docs/desktop/engine-performance-1.1-spec.md §1 与 docs/design/v2/mcp.md。
 */
import type {
  Logger,
  McpConnectOptions,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";

/**
 * 工具清单缓存：按 server 解析后配置的指纹保存上次成功的 tools/list。
 * 指纹只含结构与 env / header 键名；任何值（可能是密钥）都不参与指纹、也不写入文件。全部异步 IO。
 */
export interface McpToolManifestCache {
  /** 读取缓存清单；缺失、损坏或与指纹不符时返回 undefined，不抛错。 */
  read(serverName: string, config: McpServerConfig): Promise<McpToolDescriptor[] | undefined>;
  /** 原子写入真实清单；与本进程已知内容相同时不写盘。失败只记 warn，不抛错。 */
  write(
    serverName: string,
    config: McpServerConfig,
    tools: readonly McpToolDescriptor[],
  ): Promise<void>;
  /** 删除该指纹的缓存（首次启动失败时调用）；幂等。 */
  invalidate(serverName: string, config: McpServerConfig): Promise<void>;
}

export interface CreateMcpToolManifestCacheOptions {
  appVersion: string;
  logger?: Logger;
  /** 目录内文件数上限，超出按 mtime 淘汰最旧文件。 */
  maxEntries?: number;
  rootDir: string;
}

/** 触发首次连接的使用类型，只用于日志。 */
export type McpLazyStartTrigger = "app_connection" | "resource" | "tool_call";

/** lease 注入的能力；连接的创建与释放始终由 lease 完成。 */
export interface McpLeaseServerLifecycleDeps {
  /** lease 的 acquire：创建或复用连接并等待其结果；lease 关闭后必须抛错。 */
  acquire: (
    serverName: string,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ) => Promise<McpServerStatus>;
  cache: McpToolManifestCache;
  /** 闲置回收窗口；缺省或 <=0 不计时（设置页等无会话的 lease）。 */
  idleReclaimMs?: number;
  /**
   * 闲置策略：返回 false 的 server 永不计闲置窗口（配置声明 `idleReclaim: false` 的有状态 server）。
   * 缺省全部可回收。首次使用时启动不受影响。
   */
  isIdleReclaimable?: (serverName: string) => boolean;
  logger?: Logger;
  /**
   * 闲置窗口到期且没有在途使用时调用。lease 负责再确认（MCP App 连接、连接状态）并回收；
   * isStillIdle 供 lease 在 await 之后判断期间是否又有新使用。
   */
  onIdle?: (serverName: string, isStillIdle: () => boolean) => void;
  /** 连接成功后读取该 server 的真实工具描述。 */
  readServerTools: (serverName: string) => Promise<McpToolDescriptor[]>;
  sessionId?: string;
}

/**
 * 一个会话 lease 的 server 生命周期登记。本对象不持有连接，也不跨 lease 共享；闲置计时器全部
 * unref，forget / close 时清除。
 */
export interface McpLeaseServerLifecycle {
  /** 叠加到 lease toolListRevision 的单调计数：后台连接结束、清单漂移、首次启动失败时递增。 */
  readonly toolListRevision: number;
  /**
   * 登记启用的 server：命中缓存的推迟到首次使用，未命中的立即后台连接。只等待缓存读取；
   * settled 在全部后台连接结束后 resolve。
   */
  register(
    servers: ReadonlyArray<readonly [string, McpServerConfig]>,
    connectOptions: McpConnectOptions,
  ): Promise<{ backgroundNames: string[]; deferredNames: string[]; settled: Promise<void> }>;
  /**
   * 一次实际使用：待首次使用的 server 先单飞连接（signal 与 lease 关闭只结束等待），期间暂停闲置计时，
   * 结束后重新计时。连接结果不是 connected 时以 `code: "mcp_server_start_failed"` 的错误拒绝。
   */
  use<T>(
    serverName: string,
    trigger: McpLazyStartTrigger,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** lease 的连接已完成：从现在起计闲置窗口。 */
  connected(serverName: string): void;
  deferredNames(): string[];
  /** 待首次使用或启动中的 server 对外报告的缓存工具；其余返回 undefined。 */
  cachedTools(serverName: string): McpToolDescriptor[] | undefined;
  /** 待首次使用 server 的状态（`deferredStart: true`、status "disconnected"）。 */
  deferredStatus(serverName: string): McpServerStatus | undefined;
  /** server 被释放、换配置或显式连接/断开：丢弃登记并取消计时；幂等。 */
  forget(serverName: string): void;
  /** 闲置回收后回到待首次使用：工具沿用回收前的真实清单，registry 不变。 */
  defer(
    serverName: string,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
    tools: McpToolDescriptor[],
    releasedRevision?: number,
  ): void;
  /** lease 关闭：结束首次连接的等待、清除计时器并丢弃登记；之后不再创建连接。 */
  close(): void;
}
