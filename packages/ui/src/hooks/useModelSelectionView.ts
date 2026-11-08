import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { createSharedServiceRead, type SharedServiceRead } from "@/store/serviceAuthorityKey.js";

type ModelSelectionCatalog = Pick<ModelSelectionView, "revision" | "providers">;

type ModelSelectionSource = Pick<IModelSelectionService, "getView" | "onDidChange">;

export type SharedModelSelectionReader = SharedServiceRead<
  ModelSelectionViewInput | undefined,
  ModelSelectionView,
  ModelSelectionView
>;

// JSON.stringify(对象) 不会得到空串，空串专指“无输入”的目录 View。
const NO_INPUT_KEY = "";
const sharedModelSelectionReaders = new WeakMap<ModelSelectionSource, SharedModelSelectionReader>();

/**
 * Model Selection 的窗口级共享读取（P5，docs/desktop/engine-performance-1.1-spec.md「窗口级只读数据共享」）。
 * 修复原因：窗口打开时每个 SessionPane 的就绪门禁与 Composer 各读一次 getView（实测 27 次），每次变化事件
 * 各自重读。按服务实例（同一 Host authority）共享：同输入键只读一次；事件负载即无输入 View（Host 以
 * getView() 生成），直接作为无输入键的最新值；带输入的键在事件后只重读一次。
 */
export function getSharedModelSelectionReader(
  service: ModelSelectionSource,
): SharedModelSelectionReader {
  const existing = sharedModelSelectionReaders.get(service);
  if (existing) return existing;
  const created: SharedModelSelectionReader = createSharedServiceRead({
    keyOf: (input) => (input === undefined ? NO_INPUT_KEY : JSON.stringify(input)),
    fetch: (input) => (input === undefined ? service.getView() : service.getView(input)),
    subscribe: (onEvent) => service.onDidChange(onEvent),
    valueOfEvent: (view) => ({ key: NO_INPUT_KEY, value: view }),
  });
  sharedModelSelectionReaders.set(service, created);
  return created;
}

export type ModelSelectionState =
  | { status: "loading"; catalog?: ModelSelectionCatalog }
  | { status: "ready"; view: ModelSelectionView; refreshError?: { revision: number; error: Error } }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };

export type ModelSelectionRefreshResult =
  | { kind: "ready"; view: ModelSelectionView }
  | { kind: "superseded" };

export interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
  refresh(): Promise<ModelSelectionRefreshResult>;
}

interface OwnedModelSelectionState {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: "remote-waiting" | "missing-target";
  inputKey: string | undefined;
  state: ModelSelectionState;
}

// 首读的临时 IO 失败未必产生 Provider 变化事件；只重读两次，不轮询业务状态或重试写操作。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;
function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

function initialState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
  catalog?: ModelSelectionCatalog,
): ModelSelectionState {
  return enabled && service
    ? { status: "loading", ...(catalog ? { catalog } : {}) }
    : { status: "unavailable", reason: unavailableReason };
}

function retainedCatalog(
  previous: OwnedModelSelectionState,
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
): ModelSelectionCatalog | undefined {
  if (
    previous.service !== service ||
    previous.enabled !== enabled ||
    previous.unavailableReason !== unavailableReason
  )
    return undefined;
  // 调档/换模型只改变解析输入；清空同 Host 目录会让菜单收缩闪烁。
  // 仅保留目录，绝不把旧 effectiveSelection 当作新选择的解析结果。
  if (previous.state.status === "ready") {
    const { revision, providers } = previous.state.view;
    return { revision, providers };
  }
  return previous.state.status === "loading" ? previous.state.catalog : undefined;
}

/** 订阅明确 Host Service；返回状态在同一次 render 即绑定新 owner，不暴露旧 Host View。 */
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: "remote-waiting" | "missing-target" = "remote-waiting",
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const normalizedService = service ?? null;
  // 调用方可每次 render 创建参数对象；所有权按选择内容绑定，不按对象引用反复订阅。
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialState(normalizedService, enabled, unavailableReason),
  }));
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const generationRef = useRef(0);
  const readRef = useRef<(() => Promise<ModelSelectionRefreshResult>) | null>(null);
  const lastReloadVersionRef = useRef(reloadVersion);
  const ownerMatches =
    owned.service === normalizedService &&
    owned.enabled === enabled &&
    owned.inputKey === inputKey &&
    owned.unavailableReason === unavailableReason;
  const visibleState = ownerMatches
    ? owned.state
    : initialState(
        normalizedService,
        enabled,
        unavailableReason,
        retainedCatalog(owned, normalizedService, enabled, unavailableReason),
      );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const catalog = retainedCatalog(previous, normalizedService, enabled, unavailableReason);
    const retainedReady =
      previous.service === normalizedService &&
      previous.enabled === enabled &&
      previous.inputKey === inputKey &&
      previous.unavailableReason === unavailableReason &&
      previous.state.status === "ready"
        ? previous.state
        : null;
    setOwned({
      service: normalizedService,
      enabled,
      unavailableReason,
      inputKey,
      state: retainedReady ?? initialState(normalizedService, enabled, unavailableReason, catalog),
    });
    if (!enabled || !normalizedService) return;

    let latestRevision = retainedReady?.view.revision ?? catalog?.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    let requestId = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const commit = (candidate: ModelSelectionView): void => {
      if (generation !== generationRef.current || candidate.revision < latestRevision) return;
      latestRevision = candidate.revision;
      hasReadyView = true;
      cancelRetry();
      setOwned({
        service: normalizedService,
        enabled,
        unavailableReason,
        inputKey,
        state: { status: "ready", view: candidate },
      });
    };
    // P5：经窗口级共享读取器读取与订阅，同服务实例同输入的多个实例合并为一次请求。
    const reader = getSharedModelSelectionReader(normalizedService);
    const read = (fresh = false): Promise<ModelSelectionRefreshResult> => {
      cancelRetry();
      const request = ++requestId;
      return reader.read(stableInput, fresh ? { fresh: true } : undefined).then(
        (candidate) => {
          if (generation !== generationRef.current || request !== requestId)
            return { kind: "superseded" };
          commit(candidate);
          return { kind: "ready", view: candidate };
        },
        (cause: unknown) => {
          // 原因：旧读取虽不能写展示 state，其 rejection 仍会被等待它的 Composer 当成当前失败。
          // owner 明确返回已被取代回执；仅当前读取失败才发布失败并拒绝。
          if (generation !== generationRef.current || request !== requestId)
            return { kind: "superseded" };
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          // 原因：保留旧 ready 不能吞掉新 revision 的失败，否则连接切换会永久等待。
          // 失败与当前 service/input 及事件 revision 绑定；保留旧目录，成功重读清除回执。
          if (hasReadyView) {
            setOwned((previous) =>
              previous.state.status === "ready"
                ? {
                    ...previous,
                    state: { ...previous.state, refreshError: { revision: latestRevision, error } },
                  }
                : previous,
            );
          } else {
            setOwned({
              service: normalizedService,
              enabled,
              unavailableReason,
              inputKey,
              state: { status: "error", error },
            });
            const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
            if (delay !== undefined && isTransientReadError(cause)) {
              retryCount += 1;
              retryTimer = setTimeout(() => {
                void read().catch(() => {});
              }, delay);
            }
          }
          throw error;
        },
      );
    };
    // 原因：相同目录不会再发事件；显式重读与订阅读取共享请求序号，迟到旧失败不能覆盖重试。
    // refresh 是显式重读，不读共享缓存。
    const refresh = () => read(true);
    readRef.current = refresh;
    const subscription = reader.onDidChange((candidate) => {
      if (generation !== generationRef.current) return;
      if (stableInput === undefined) commit(candidate);
      else {
        // 公共事件没有某个调用者的原意图；只能用它触发当前输入重读，不能直接接管结果。
        // 共享读取器已在通知前作废缓存，同输入的各实例重读合并为一次请求。
        latestRevision = Math.max(latestRevision, candidate.revision);
        void read().catch(() => {});
      }
    });
    // reload 是显式重试入口：本次 effect 因 reloadVersion 变化重跑时发新请求，不读共享缓存。
    const explicitReload = lastReloadVersionRef.current !== reloadVersion;
    lastReloadVersionRef.current = reloadVersion;
    void read(explicitReload).catch(() => {});
    return () => {
      generationRef.current += 1;
      if (readRef.current === refresh) readRef.current = null;
      cancelRetry();
      subscription.dispose();
    };
  }, [enabled, normalizedService, reloadVersion, unavailableReason, inputKey, stableInput]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    refresh: useCallback(
      () =>
        readRef.current
          ? readRef.current()
          : Promise.reject(new Error("Model selection owner unavailable")),
      [],
    ),
  };
}

/** 模型候选只来自明确 Workspace Target；等待远端时不读取 Local/Base Host。 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    input,
  );
}
