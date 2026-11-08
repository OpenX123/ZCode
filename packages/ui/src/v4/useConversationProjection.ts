import { useCallback, useSyncExternalStore } from "react";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const NOOP_UNSUBSCRIBE = () => {};

export interface ConversationProjectionOptions {
  /**
   * 暂停渲染通知（docs/desktop/engine-performance-1.1-spec.md「隐藏面板暂停渲染」）：不向 store
   * 注册监听，store 仍照常应用每一帧，租约与订阅不变；恢复时首个渲染读取 store 当前状态一次补齐。
   */
  paused?: boolean;
}

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(
  lease: SessionLease | null,
  options?: ConversationProjectionOptions,
): ConversationStoreState {
  const store = lease?.store ?? null;
  const paused = options?.paused === true;
  // 修复原因（2026-11-08 P9）：激活过的隐藏 Tab 保留租约，原实现无条件订阅，CLI 每 30ms 一帧时
  // 隐藏的 SessionPane 与时间线每秒最多重渲染约 33 次。暂停时不注册监听；subscribe 随 paused 换引用，
  // 恢复时 React 重新订阅并立即比对快照，补齐隐藏期间的变化。subscribe 同时改为稳定引用，
  // 不再每次渲染退订再订阅。
  const subscribe = useCallback(
    (listener: () => void) => (store && !paused ? store.subscribe(listener) : NOOP_UNSUBSCRIBE),
    [store, paused],
  );
  const getSnapshot = useCallback(() => store?.getState() ?? CLOSED_STATE, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, () => CLOSED_STATE);
}
