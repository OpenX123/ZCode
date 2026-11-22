import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RunningToolActivity, RunningToolActivityProviderProps } from "./contract.js";
import { STALL_TICK_MS, resolveRunningToolActivity, runningToolElapsedMinutes } from "./model.js";

/**
 * 运行中工具行耗时（docs/chat/turn-stall-indicator.md「工具行耗时」）。
 *
 * 事实来源仍是 runtime 的 `turnActivity`；这里的 store 只是 provider 内部的展示派生缓存：
 * 时间线里的工具行很多，直接用 context 值会让每次 turnActivity 刷新（运行中最多每 5s）都重渲染
 * 所有 ToolLayout。改为 `useSyncExternalStore` 订阅，只有「当前运行工具」变化才通知，且只有 id
 * 命中的那一行自行 tick。
 */
interface RunningToolActivityStore {
  get: () => RunningToolActivity | null;
  set: (next: RunningToolActivity | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function createRunningToolActivityStore(
  initial: RunningToolActivity | null,
): RunningToolActivityStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      const unchanged =
        current?.toolCallId === next?.toolCallId &&
        current?.phaseStartedAt === next?.phaseStartedAt;
      if (unchanged) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const RunningToolActivityContext = createContext<RunningToolActivityStore | null>(null);

const unsubscribeNoop = () => {};
const subscribeNoop = () => unsubscribeNoop;
const getNoActivity = () => null;

export function RunningToolActivityProvider({
  turnActivity,
  running,
  hasPendingInteraction,
  disabled = false,
  children,
}: RunningToolActivityProviderProps) {
  const activity = disabled
    ? null
    : resolveRunningToolActivity({ turnActivity, running, hasPendingInteraction });
  const toolCallId = activity?.toolCallId ?? null;
  const phaseStartedAt = activity?.phaseStartedAt ?? null;
  const [store] = useState(() => createRunningToolActivityStore(activity));
  useEffect(() => {
    store.set(
      toolCallId !== null && phaseStartedAt !== null ? { toolCallId, phaseStartedAt } : null,
    );
  }, [phaseStartedAt, store, toolCallId]);
  return (
    <RunningToolActivityContext.Provider value={store}>
      {children}
    </RunningToolActivityContext.Provider>
  );
}

/**
 * 工具行耗时分钟数：`toolCallIds` 含当前运行工具且已运行 ≥60s 时返回分钟数，否则 null。
 * 传 null（工具未运行）时不订阅；provider 缺省（嵌套渲染、历史回放）时恒为 null。
 */
export function useRunningToolElapsedMinutes(toolCallIds: readonly string[] | null): number | null {
  const store = useContext(RunningToolActivityContext);
  const subscribed = store !== null && toolCallIds !== null && toolCallIds.length > 0;
  const activity = useSyncExternalStore(
    subscribed ? store.subscribe : subscribeNoop,
    subscribed ? store.get : getNoActivity,
    subscribed ? store.get : getNoActivity,
  );
  const startedAt =
    activity !== null && toolCallIds?.includes(activity.toolCallId)
      ? activity.phaseStartedAt
      : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), STALL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? null : runningToolElapsedMinutes(startedAt, nowMs);
}

/** 工具行尾的耗时文案（如「1 分钟」）；不满足显示条件时为 null。 */
export function useRunningToolElapsedLabel(toolCallIds: readonly string[] | null): string | null {
  const { intl } = useZCodeIntl();
  const minutes = useRunningToolElapsedMinutes(toolCallIds);
  if (minutes === null) return null;
  return intl.formatMessage(
    { id: minutes === 1 ? "chat.stall.toolElapsed.one" : "chat.stall.toolElapsed.other" },
    { minutes },
  );
}
