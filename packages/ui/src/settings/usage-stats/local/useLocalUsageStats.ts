import { useCallback, useEffect, useRef, useState } from "react";
import {
  localUsageSnapshotSchema,
  type LocalUsageRange,
  type LocalUsageSnapshot,
  type LocalUsageSource,
  type ModelPrice,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";

/** 统计页停留期间的刷新间隔；页面卸载或不可见时不扫描（docs/usage-stats-local-sources.md §3）。 */
export const LOCAL_USAGE_REFRESH_INTERVAL_MS = 30_000;

export interface LocalUsageQuery {
  source: LocalUsageSource;
  range: LocalUsageRange;
  customStartDate?: string | null;
  customEndDate?: string | null;
}

interface LocalUsageState {
  snapshot: LocalUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLocalUsageStats(query: LocalUsageQuery) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<LocalUsageState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);
  const { source, range, customStartDate, customEndDate } = query;

  const refresh = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const raw = await usageStatsService.getLocalUsageSnapshot({
        source,
        range,
        ...(range === "custom" ? { customStartDate, customEndDate } : {}),
        timeZone,
      });
      // RPC 结果做运行时校验，避免 Host 版本不一致时把坏数据交给图表。
      const snapshot = localUsageSnapshotSchema.parse(raw);
      if (requestVersionRef.current !== requestVersion) return;
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) return;
      const message = getErrorMessage(error);
      logger.warn("[useLocalUsageStats] 读取本机用量失败", { source, range, error: message });
      setState((current) => ({ ...current, loading: false, error: message }));
    }
  }, [customEndDate, customStartDate, range, source, usageStatsService]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, LOCAL_USAGE_REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      // 卸载后迟到的响应一律丢弃。
      requestVersionRef.current += 1;
    };
  }, [refresh]);

  const setModelPrice = useCallback(
    async (modelId: string, price: ModelPrice | null) => {
      await usageStatsService.setModelPriceOverride({ modelId, price });
      await refresh();
    },
    [refresh, usageStatsService],
  );

  const syncPrices = useCallback(async () => {
    const result = await usageStatsService.syncModelPrices();
    await refresh();
    return result;
  }, [refresh, usageStatsService]);

  return { ...state, refresh, setModelPrice, syncPrices };
}
