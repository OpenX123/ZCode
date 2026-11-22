// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_USAGE_REFRESH_INTERVAL_MS,
  useLocalUsageStats,
} from "@/settings/usage-stats/local/useLocalUsageStats.js";
import { createLocalUsageSnapshot } from "./fixtures/localUsageSnapshot.js";

const usage = vi.hoisted(() => ({
  getLocalUsageSnapshot: vi.fn(),
  setModelPriceOverride: vi.fn(),
  syncModelPrices: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ usageStatsService: usage }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("useLocalUsageStats（LU-12）", () => {
  it("挂载即扫描，停留期间每 30s 刷新，卸载后不再请求", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    usage.getLocalUsageSnapshot.mockResolvedValue(createLocalUsageSnapshot());
    const { result, unmount } = renderHook(() =>
      useLocalUsageStats({ source: "all", range: "7d" }),
    );
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(usage.getLocalUsageSnapshot).toHaveBeenCalledWith({
      source: "all",
      range: "7d",
      timeZone: expect.any(String),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_USAGE_REFRESH_INTERVAL_MS);
    });
    expect(usage.getLocalUsageSnapshot).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(LOCAL_USAGE_REFRESH_INTERVAL_MS * 2);
    expect(usage.getLocalUsageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("自定义范围传递起止日期；不合法的 RPC 结果被拒绝并保留旧快照", async () => {
    const good = createLocalUsageSnapshot();
    usage.getLocalUsageSnapshot.mockResolvedValueOnce(good).mockResolvedValueOnce({ bogus: true });
    const { result } = renderHook(() =>
      useLocalUsageStats({
        source: "codex",
        range: "custom",
        customStartDate: "2026-11-01",
        customEndDate: "2026-11-02",
      }),
    );
    await waitFor(() => expect(result.current.snapshot).toEqual(good));
    expect(usage.getLocalUsageSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ customStartDate: "2026-11-01", customEndDate: "2026-11-02" }),
    );
    await act(() => result.current.refresh());
    expect(result.current.snapshot).toEqual(good);
    expect(result.current.error).toBeTruthy();
  });

  it("改价与同步价格后刷新快照", async () => {
    usage.getLocalUsageSnapshot.mockResolvedValue(createLocalUsageSnapshot());
    usage.syncModelPrices.mockResolvedValue({ syncedAt: 1, modelCount: 3 });
    const { result } = renderHook(() => useLocalUsageStats({ source: "all", range: "7d" }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(() => result.current.setModelPrice("glm-4.6", null));
    expect(usage.setModelPriceOverride).toHaveBeenCalledWith({ modelId: "glm-4.6", price: null });
    await act(async () => {
      await expect(result.current.syncPrices()).resolves.toEqual({ syncedAt: 1, modelCount: 3 });
    });
    expect(usage.getLocalUsageSnapshot).toHaveBeenCalledTimes(3);
  });
});
