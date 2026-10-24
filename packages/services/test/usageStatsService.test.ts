import { describe, expect, it, vi } from "vitest";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";

describe("本地会话用量", () => {
  it("只转发到会话运行时，不请求官方账号或配额接口", async () => {
    const snapshot = { sessions: [] };
    const getAppUsageStats = vi.fn(async () => snapshot);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("禁止原厂请求"));
    try {
      const service = createUsageStatsService({ zcodeAgentService: { getAppUsageStats } } as never);
      const request = { workspacePath: "/local/harness" };
      await expect(service.getAppUsageSnapshot(request as never)).resolves.toBe(snapshot);
      expect(getAppUsageStats).toHaveBeenCalledWith(request);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
