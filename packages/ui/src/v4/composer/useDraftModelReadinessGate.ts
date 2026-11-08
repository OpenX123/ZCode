import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { getSharedModelSelectionReader } from "@/hooks/useModelSelectionView.js";
import {
  buildModelConfigMissingUiError,
  type ModelConfigMissingUiError,
} from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessState {
  scope: object;
  status: DraftModelReadinessStatus;
  dismissed: boolean;
}

export interface DraftModelReadinessGate {
  /** 只有 readiness 已确认或检查本身不可用时，才允许进入 workspace prepare/prewarm。 */
  agentStartupAllowed: boolean;
  error: ModelConfigMissingUiError | null;
  dismissError(): void;
  /** 首发 admission 的权威复查；false 表示应保留 composer 并返回 blocked。 */
  ensureReadyForSend(): Promise<boolean>;
  /** Host 门禁在 UI 复查后竞态命中时，将同一错误重新投影到草稿横幅。 */
  markProviderNotReady(): void;
}

export function resolveModelSelectionReadinessStatus(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * V4 草稿的 provider/model admission。
 *
 * V4 迁移删除了旧 useWorkspacePrepare 的 renderer readiness 门禁，草稿首发
 * 会先登记 pending command，再由 Host 以 provider_not_ready 拒绝。这个确定性拒绝随后会
 * 被恢复账本误判成 unknown。这里恢复 UI 前置门禁；Host 门禁继续负责进程级竞态兜底。
 */
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  enabled?: boolean;
  modelSelectionService: Pick<IModelSelectionService, "getView" | "onDidChange"> | null;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled =
    params.enabled !== false &&
    Boolean(modelSelectionService) &&
    sessionId === null &&
    isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceKey}\u0000${displayProvider}`;
  const scope = useMemo(() => ({ gateKey }), [enabled, gateKey, modelSelectionService]);
  const [state, setState] = useState<DraftModelReadinessState>(() => ({
    scope,
    status: enabled ? "checking" : "ready",
    dismissed: false,
  }));
  // 进入新草稿的首帧不能沿用正式会话的 ready，否则先建预热、effect 再改 checking，
  // 会立刻回收在途创建。检查结果只属于本次生命周期，旧复查也不能覆盖新草稿。
  const effectiveState: DraftModelReadinessState =
    state.scope === scope
      ? state
      : { scope, status: enabled ? "checking" : "ready", dismissed: false };
  if (state.scope !== scope) setState(effectiveState);
  // 1.1 Renderer 发送路径：首发复查读订阅投影（挂载读取 + onDidChange），不再每次发送一次
  // getView IPC。ref 与 state 同 scope；initialRead 是本 scope 唯一在途的首次读取。
  const latestRef = useRef<{
    scope: object;
    status: DraftModelReadinessStatus;
    initialRead?: Promise<void>;
  }>({ scope, status: effectiveState.status });
  if (latestRef.current.scope !== scope)
    latestRef.current = { scope, status: effectiveState.status };

  const commitStatus = useCallback(
    (status: DraftModelReadinessStatus, options: { revealMissing?: boolean } = {}) => {
      if (latestRef.current.scope === scope) latestRef.current.status = status;
      setState((current) =>
        current.scope !== scope
          ? current
          : {
              scope,
              status,
              dismissed:
                status === "missing"
                  ? options.revealMissing
                    ? false
                    : current.status === "missing"
                      ? current.dismissed
                      : false
                  : false,
            },
      );
    },
    [scope],
  );

  useEffect(() => {
    if (!enabled || !modelSelectionService) {
      commitStatus("ready");
      return;
    }

    commitStatus("checking");
    let disposed = false;
    let registryEventVersion = 0;
    const applyStatus = (status: DraftModelReadinessStatus) => {
      if (disposed) return;
      commitStatus(status);
    };
    // P5：每个草稿门禁原先各读一次 getView、各订阅一次事件；改经窗口级共享读取器，
    // 同一服务实例上的门禁与 Root 共用一次无输入读取与一次事件订阅。
    const reader = getSharedModelSelectionReader(modelSelectionService);
    const subscription = reader.onDidChange((view) => {
      registryEventVersion += 1;
      applyStatus(resolveModelSelectionReadinessStatus(view));
    });
    const initialReadVersion = registryEventVersion;
    const initialRead = reader
      .read(undefined)
      .then((view) => {
        // 读取在变更事件之前发起、之后才返回时，事件快照更新；禁止旧读取覆盖新状态。
        if (registryEventVersion !== initialReadVersion) return;
        applyStatus(resolveModelSelectionReadinessStatus(view));
      })
      .catch((error) => {
        handleReadinessFailure(error);
      });
    if (latestRef.current.scope === scope) latestRef.current.initialRead = initialRead;

    function handleReadinessFailure(error: unknown) {
      if (disposed) return;
      // registry 读取异常不等价于“确实没有模型”。保留 Host 门禁作为兜底，避免把
      // app-global service 的瞬时故障错误显示成用户配置问题。
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry 检查失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    }

    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [commitStatus, enabled, modelSelectionService, scope, workspaceKey]);

  const markProviderNotReady = useCallback(() => {
    commitStatus("missing", { revealMissing: true });
  }, [commitStatus]);

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled || !modelSelectionService) return true;
    let known = latestRef.current.scope === scope ? latestRef.current : undefined;
    if (known?.status === "checking" && known.initialRead) {
      // 挂载读取仍在途：等待同一次读取，不另发 IPC。
      await known.initialRead;
      known = latestRef.current.scope === scope ? latestRef.current : undefined;
    }
    // 订阅投影已确认有模型直接放行；读取失败与挂载检查一致交给 Host 门禁。
    if (known?.status === "ready" || known?.status === "check-failed") return true;
    // 只有“没有模型”会拦截发送：拦截前做一次权威读取，避免变更事件在途时误拦。
    // 权威复查不读共享缓存（fresh），结果仍会刷新同服务实例的共享缓存。
    try {
      const view = await getSharedModelSelectionReader(modelSelectionService).read(undefined, {
        fresh: true,
      });
      const status = resolveModelSelectionReadinessStatus(view);
      commitStatus(status, { revealMissing: status === "missing" });
      if (status === "missing") {
        logger.info("[v4-draft-readiness] 无可用 provider/model，草稿首发在 UI admission 拒绝", {
          providerCount: view.providers.length,
          revision: view.revision,
          workspaceKey,
        });
        return false;
      }
      return true;
    } catch (error) {
      // 与 mount 检查一致：读 registry 失败不冒充“没有模型”，继续由 Host 启动门禁裁决。
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] 首发复查 provider registry 失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      return true;
    }
  }, [commitStatus, enabled, modelSelectionService, scope, workspaceKey]);

  const error = useMemo(
    () =>
      enabled && effectiveState.status === "missing" && !effectiveState.dismissed
        ? buildModelConfigMissingUiError()
        : null,
    [effectiveState.dismissed, effectiveState.status, enabled],
  );

  const dismissError = useCallback(() => {
    setState((current) =>
      current.scope === scope && current.status === "missing"
        ? { ...current, dismissed: true }
        : current,
    );
  }, [scope]);

  return {
    agentStartupAllowed:
      !enabled || effectiveState.status === "ready" || effectiveState.status === "check-failed",
    error,
    dismissError,
    ensureReadyForSend,
    markProviderNotReady,
  };
}
