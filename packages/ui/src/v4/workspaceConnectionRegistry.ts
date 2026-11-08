// 按 endpoint + workspaceKey 复用的 conversation 连接注册表（引用计数 + keep-warm）
// ——分屏多 pane 跨 workspace 的连接层。
// 同一 endpoint 同一 workspace 的多个 pane 共享一条 transport + 一个 SessionDataLayer
// （同 session 多 pane 由 layer 内 per-topic refCount 单订阅收口，不触发 CLI
// (connectionId, topic) 重订阅替换）。与 sessionsIndexRegistry 同构，多两点：
// - 30s keep-warm：refCount 归零不立即 dispose（防 pane 关/开、布局调整抖动）；
// - agentService 换代：远程条目保持 layer/transport 身份并单向切换最新 proxy；
//   本地 __base__ 用新 service 重建条目。
import type { IZCodeAgentService } from "@zcode/services";
import { MAX_VISIBLE_SESSIONS_PER_REPORT } from "@zcode/shared/zcode-protocol-v4";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/** 注册表需要的 agentService 窄面（= conversation transport 的依赖面，便于测试注入）。 */
export type WorkspaceConnectionAgentService = Pick<
  IZCodeAgentService,
  | "helloConversationV4"
  | "initializeConversationV4"
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "unsubscribeConversationV4"
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle" | "reportConversationVisibilityV4">>;

export interface WorkspaceConnectionScope {
  /** = pane 绑定的 primary workspace（连接路由键）。 */
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度：remote shard 的 remoteSessionId；缺省 = 本机 __base__。 */
  remoteSessionId?: string;
}

/** pane 持有的连接租约；release 幂等。 */
/**
 * useSavedWorkflowLauncher 的推断返回类型包含 lease，声明生成要求保留可命名的导出。
 * @lintignore
 */
export interface WorkspaceConnectionLease {
  readonly layer: SessionDataLayer;
  readonly transport: ConversationTransport;
  /** React commit 后激活本租约携带的远程 service；本地租约为 no-op。 */
  activateRemoteService(): void;
  /**
   * 登记某个 pane 当前可见的会话（不可见或无租约传 null）。同一工作区连接的全部 pane 由
   * 本连接的可见性上报器合并后整体上报（docs/desktop/engine-performance-1.1-spec.md「会话可见性上报」）。
   */
  setPaneVisibleSession(ownerKey: string, sessionId: string | null): void;
  release(): void;
}

interface RegistryEntry {
  key: string;
  agentService: WorkspaceConnectionAgentService;
  agentServiceGeneration: number;
  transport: ConversationTransport;
  replaceableTransport: ReplaceableConversationTransport | null;
  layer: SessionDataLayer;
  visibility: ConversationVisibilityReporter;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
  /** 本地 service 换代后被移出注册表的旧条目：末位 lease release 时立即 dispose。 */
  stale: boolean;
}

type VisibilityDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

function currentDocument(): VisibilityDocument | undefined {
  return typeof document === "undefined" ? undefined : document;
}

/**
 * 工作区连接的会话可见性上报器（P3，2026-11-08）。
 *
 * 修复原因：CLI 以 Renderer 上报的可见集合豁免外部引擎会话的闲置关闭，从未上报一律视为不可见；
 * 未接入前，正在看的外部引擎会话闲置 15 分钟也会被关闭。CLI 按连接整体替换集合，所以同一工作区
 * 连接只能有一个上报者，否则多个 pane 各报各的会互相覆盖——本对象就是该连接可见集合的唯一所有者。
 *
 * - 可见事实来自 pane 登记（SessionPane 的 paneVisible + 租约）与窗口 document.visibilityState；
 * - 同一提交周期的变化合并为一次上报（microtask）；集合未变不重报；
 * - 串行：至多一个在途上报，在途期间的变化在返回后按最新集合补发（后到覆盖先到）；
 * - 不拉起 CLI：失败（CLI 不在、旧 Host/CLI）只记 debug，不轮询；runtime available 或远端
 *   proxy 换代后 CLI 侧集合为空，按当前集合重报。
 */
class ConversationVisibilityReporter {
  private readonly owners = new Map<string, string>();
  /** CLI 侧已确认的集合（排序后 join）；"" = 空集合（CLI 缺省），null = 未知（上次失败）。 */
  private confirmedKey: string | null = "";
  private inFlight = false;
  private pendingAfterFlight = false;
  private scheduled = false;
  private disposed = false;
  private listening = false;
  private readonly offListeners: Array<() => void> = [];

  constructor(
    private readonly transport: ConversationTransport,
    private readonly key: string,
  ) {}

  set(ownerKey: string, sessionId: string | null): void {
    if (this.disposed) return;
    const previous = this.owners.get(ownerKey);
    if (sessionId === null) this.owners.delete(ownerKey);
    else this.owners.set(ownerKey, sessionId);
    if (previous === (sessionId ?? undefined)) return;
    this.listen();
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offListeners.splice(0)) off();
    this.owners.clear();
  }

  private listen(): void {
    if (this.listening || !this.transport.reportVisibility) return;
    this.listening = true;
    const doc = currentDocument();
    if (doc) {
      const onVisibilityChange = () => this.schedule();
      doc.addEventListener("visibilitychange", onVisibilityChange);
      this.offListeners.push(() => doc.removeEventListener("visibilitychange", onVisibilityChange));
    }
    // 与 sessionsIndexStore 同一模式：有 runtime lifecycle 时只用它判定 CLI 新生；
    // onRuntimeRestart 只补远端 proxy 换代（新连接上 CLI 侧集合为空）。
    if (this.transport.onRuntimeLifecycle) {
      this.offListeners.push(
        this.transport.onRuntimeLifecycle((state) => {
          if (state === "available") this.resetConfirmed();
        }),
      );
    }
    const lifecycleTracked = Boolean(this.transport.onRuntimeLifecycle);
    this.offListeners.push(
      this.transport.onRuntimeRestart((reason) => {
        if (!lifecycleTracked || reason === "transportReplaced") this.resetConfirmed();
      }),
    );
  }

  /** CLI 新生或连接换代：CLI 侧集合已为空，按当前集合重报（当前为空则无需上报）。 */
  private resetConfirmed(): void {
    this.confirmedKey = "";
    this.schedule();
  }

  private desired(): string[] {
    if (currentDocument()?.visibilityState === "hidden") return [];
    const ids = [...new Set(this.owners.values())].sort();
    if (ids.length > MAX_VISIBLE_SESSIONS_PER_REPORT) {
      logger.warn("[v4-visibility] 可见会话超过上报上限，截断", {
        key: this.key,
        count: ids.length,
        max: MAX_VISIBLE_SESSIONS_PER_REPORT,
      });
      return ids.slice(0, MAX_VISIBLE_SESSIONS_PER_REPORT);
    }
    return ids;
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.transport.reportVisibility) return;
    if (this.inFlight) {
      this.pendingAfterFlight = true;
      return;
    }
    const ids = this.desired();
    const key = ids.join("\n");
    if (key === this.confirmedKey) return;
    this.inFlight = true;
    try {
      await this.transport.reportVisibility(ids);
      this.confirmedKey = key;
    } catch (error) {
      // CLI 不在（existing-only）或旧 Host/CLI 不支持：不重试；CLI 新生时按当前集合重报。
      this.confirmedKey = null;
      logger.debug("[v4-visibility] 可见性上报未送达", {
        key: this.key,
        count: ids.length,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
      if (this.pendingAfterFlight) {
        this.pendingAfterFlight = false;
        this.schedule();
      }
    }
  }
}

const registry = new Map<string, RegistryEntry>();

/** 本机 endpoint 的保留键（与 sessionsIndexRegistry / task list shardKey 口径一致）。 */
export const LOCAL_WORKSPACE_CONNECTION_ENDPOINT = "__base__";

/** 引用归零后延迟释放窗口（ms）；与 SessionDataLayer keep-warm 同标度。 */
export const WORKSPACE_CONNECTION_KEEP_WARM_MS = 30_000;

/** 注册表条目键 = endpoint + workspaceKey（同 workspaceKey 不同 endpoint 不共用）。 */
export function buildWorkspaceConnectionKey(scope: WorkspaceConnectionScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return `${scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT} ${workspaceKey}`;
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.keepWarmTimer !== null) {
    clearTimeout(entry.keepWarmTimer);
    entry.keepWarmTimer = null;
  }
  entry.visibility.dispose();
  entry.layer.dispose();
}

function releaseEntry(entry: RegistryEntry): void {
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    logger.lifecycle.info("v4 workspace connection lease released", {
      event: "v4.workspace_connection.release",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      status: "completed",
    });
    return;
  }
  if (entry.stale) {
    // 已被换代移出注册表：没有新消费者会再命中它，立即清场。
    disposeEntry(entry);
    logger.lifecycle.info("v4 stale workspace connection disposed", {
      event: "v4.workspace_connection.stale_disposed",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
    return;
  }
  // 关 pane ≠ 停 session：延迟退订，防布局抖动期间反复建连/退订。
  entry.keepWarmTimer = setTimeout(() => {
    if (registry.get(entry.key) === entry) {
      registry.delete(entry.key);
    }
    entry.visibility.dispose();
    entry.layer.dispose();
    logger.lifecycle.info("v4 workspace connection keep-warm expired", {
      event: "v4.workspace_connection.keep_warm_expired",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
  }, WORKSPACE_CONNECTION_KEEP_WARM_MS);
  logger.lifecycle.info("v4 workspace connection lease released", {
    event: "v4.workspace_connection.release",
    keepWarmMs: WORKSPACE_CONNECTION_KEEP_WARM_MS,
    key: entry.key,
    module: "ui.v4.workspace_connection_registry",
    refCount: 0,
    status: "keep_warm",
  });
}

/**
 * 取/建某 endpoint+workspace 的共享 conversation 连接，refCount++。
 * agentService 由调用方（V4PaneConversationProvider 经 useWorkspaceServicesResolution）解析；
 * 调用方只在 local-ready / remote-ready 时进入本层。remote-waiting 不会拿断连代理
 * 创建 registry entry，同时仍禁止回落 base services 或为 pane 另起独立 runtime。
 */
export function acquireWorkspaceConnection(
  scope: WorkspaceConnectionScope,
  agentService: WorkspaceConnectionAgentService,
  createLocalMediaPreviewUrl?: (path: string) => string,
): WorkspaceConnectionLease {
  const key = buildWorkspaceConnectionKey(scope);
  const existing = registry.get(key);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const isRemote =
    (scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT) !==
    LOCAL_WORKSPACE_CONNECTION_ENDPOINT;
  let entry: RegistryEntry;
  if (existing && (existing.agentService === agentService || isRemote)) {
    existing.refCount += 1;
    if (existing.keepWarmTimer !== null) {
      clearTimeout(existing.keepWarmTimer);
      existing.keepWarmTimer = null;
    }
    entry = existing;
    logger.lifecycle.info("v4 workspace connection reused", {
      event: "v4.workspace_connection.reused",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  } else {
    if (existing) {
      // 本地 __base__ service 换代：旧条目失效移出；
      // 无人持有则立即清场，有人持有则由其末位 release 清场。
      registry.delete(key);
      existing.stale = true;
      if (existing.refCount <= 0) {
        disposeEntry(existing);
      }
    }
    const initialTransport = createAgentConversationTransport(agentService, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(createLocalMediaPreviewUrl ? { createLocalMediaPreviewUrl } : {}),
    });
    const replaceableTransport = isRemote
      ? new ReplaceableConversationTransport(initialTransport)
      : null;
    const transport = replaceableTransport ?? initialTransport;
    entry = {
      key,
      agentService,
      agentServiceGeneration: incomingServiceGeneration,
      transport,
      replaceableTransport,
      layer: new SessionDataLayer({ transport }),
      visibility: new ConversationVisibilityReporter(transport, key),
      refCount: 1,
      keepWarmTimer: null,
      stale: false,
    };
    registry.set(key, entry);
    logger.lifecycle.info("v4 workspace connection created", {
      event: "v4.workspace_connection.created",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 1,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  }

  let released = false;
  return {
    layer: entry.layer,
    transport: entry.transport,
    activateRemoteService: () => {
      if (
        released ||
        !isRemote ||
        entry.stale ||
        entry.agentService === agentService ||
        incomingServiceGeneration <= entry.agentServiceGeneration
      ) {
        return;
      }
      // acquire 会在 React render 中执行；若此处同步 replace，会经
      // runtimeRestart listener 更新外部 store 并发起 RPC。租约只捕获候选 service，
      // 由 Provider 在 commit 阶段显式激活，同时保持 generation 单向切换。
      if (!entry.replaceableTransport) {
        throw new Error("远程 conversation registry 条目缺少可换代 transport");
      }
      entry.agentService = agentService;
      entry.agentServiceGeneration = incomingServiceGeneration;
      entry.replaceableTransport.replace(
        createAgentConversationTransport(agentService, {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        }),
      );
    },
    setPaneVisibleSession: (ownerKey, sessionId) => {
      entry.visibility.set(ownerKey, sessionId);
    },
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}

/** 仅测试/诊断用：当前注册的连接条目数（不含已换代失效、待存量租约释放的旧条目）。 */
export function workspaceConnectionRegistrySize(): number {
  return registry.size;
}
