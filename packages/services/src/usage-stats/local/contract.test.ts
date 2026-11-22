import { describe, expect, it } from "vitest";
import { aggregateLocalUsage } from "./index.js";
import type { LocalUsageIndex } from "./contract.js";
import { usageStatsLocalModule } from "./module.js";

function emptyIndex(): LocalUsageIndex {
  return {
    claudeEntries: [],
    codexEntries: [],
    zcodeFacts: [],
    externalSessions: [],
    claudeFiles: 0,
    codexFiles: 0,
    malformedLines: 0,
    zcodeNativeAvailable: false,
    scannedAt: 0,
    durationMs: 0,
  };
}

describe("usage-stats-local contract", () => {
  it("declares its module manifest", () => {
    expect(usageStatsLocalModule.id).toBe("usage-stats-local");
  });

  it("aggregates an empty index into a continuous empty snapshot", () => {
    const snapshot = aggregateLocalUsage({
      index: emptyIndex(),
      request: { source: "all", range: "7d" },
      timeZone: "UTC",
      pricing: { manual: {}, synced: {} },
      pricingSyncedAt: null,
      now: Date.parse("2026-11-22T00:00:00Z"),
    });
    expect(snapshot.summary.requestCount).toBe(0);
    expect(snapshot.daily).toHaveLength(7);
    expect(snapshot.heatmapWeeks).toHaveLength(53);
    expect(snapshot.requests).toEqual([]);
  });
});
