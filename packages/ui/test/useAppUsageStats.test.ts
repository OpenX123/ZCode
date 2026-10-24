// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot } from "@zcode/shared";
import { useAppUsageStats } from "@/hooks/useUsageStats.js";

const localUsage = vi.hoisted(() => ({ getAppUsageSnapshot: vi.fn() }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ usageStatsService: localUsage }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

describe("本地 App Usage", () => {
  it("无需账号或套餐服务即可读取本地统计，失败时保留已有快照", async () => {
    const snapshot = { source: "agent-db", range: "7d", generatedAt: 1 } as AppUsageSnapshot;
    localUsage.getAppUsageSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("local-db-unavailable"));
    const { result } = renderHook(() => useAppUsageStats("7d"));
    await waitFor(() => expect(result.current.snapshot).toBe(snapshot));
    expect(localUsage.getAppUsageSnapshot).toHaveBeenCalledWith({
      range: "7d",
      timeZone: expect.any(String),
    });
    await act(() => result.current.refresh());
    expect(result.current.snapshot).toBe(snapshot);
    expect(result.current.error).toBe("local-db-unavailable");
    expect(result.current.loading).toBe(false);
  });

  it("快速切换统计范围时丢弃旧请求的迟到快照", async () => {
    const first = deferred<AppUsageSnapshot>();
    const second = deferred<AppUsageSnapshot>();
    localUsage.getAppUsageSnapshot
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ range }: { range: "7d" | "30d" }) => useAppUsageStats(range),
      { initialProps: { range: "7d" } },
    );
    rerender({ range: "30d" });
    const current = { source: "agent-db", range: "30d", generatedAt: 2 } as AppUsageSnapshot;
    await act(async () => second.resolve(current));
    await act(async () =>
      first.resolve({ source: "agent-db", range: "7d", generatedAt: 1 } as AppUsageSnapshot),
    );
    expect(result.current.snapshot).toBe(current);
    expect(result.current.error).toBeNull();
  });
});
