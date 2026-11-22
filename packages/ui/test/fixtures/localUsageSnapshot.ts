import type { LocalUsageSnapshot } from "@zcode/shared";

/** 合成的本机用量快照（无真实用户数据）。 */
export function createLocalUsageSnapshot(
  overrides: Partial<LocalUsageSnapshot> = {},
): LocalUsageSnapshot {
  return {
    generatedAt: Date.parse("2026-11-22T12:00:00Z"),
    timeZone: "UTC",
    source: "all",
    range: "7d",
    startDate: "2026-11-16",
    endDate: "2026-11-22",
    summary: {
      inputTokens: 1_200,
      outputTokens: 800,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 2_000,
      totalTokens: 10_000,
      requestCount: 12,
      costUsd: 1.25,
      unpricedTokens: 0,
      cacheHitRate: 0.65,
    },
    daily: [
      { date: "2026-11-21", totalTokens: 4_000, requestCount: 5, costUsd: 0.5 },
      { date: "2026-11-22", totalTokens: 6_000, requestCount: 7, costUsd: 0.75 },
    ],
    heatmapWeeks: [
      {
        weekIndex: 0,
        days: [
          { date: "2026-11-22", level: 4, totalTokens: 6_000, turnCount: 7, toolCallCount: 0 },
        ],
      },
    ],
    models: [
      {
        modelId: "synthetic-sonnet",
        inputTokens: 1_200,
        outputTokens: 800,
        cacheReadTokens: 6_000,
        cacheWriteTokens: 2_000,
        totalTokens: 10_000,
        requestCount: 12,
        costUsd: 1.25,
        share: 1,
      },
    ],
    projects: [
      {
        cwd: "/synthetic/work/project-a",
        totalTokens: 10_000,
        requestCount: 12,
        costUsd: 1.25,
        lastActiveDate: "2026-11-22",
      },
    ],
    requests: [
      {
        id: "req-1",
        timestamp: Date.parse("2026-11-22T10:00:00Z"),
        origin: "zcode-claude-code",
        modelId: "synthetic-sonnet",
        cwd: "/synthetic/work/project-a",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        costUsd: 0.01,
      },
    ],
    requestTotal: 1,
    pricing: [
      {
        modelId: "synthetic-sonnet",
        price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
        origin: "builtin",
        used: true,
      },
    ],
    pricingSyncedAt: null,
    scan: {
      claudeFiles: 2,
      codexFiles: 1,
      malformedLines: 0,
      zcodeNativeAvailable: true,
      scannedAt: Date.parse("2026-11-22T12:00:00Z"),
      durationMs: 12,
    },
    ...overrides,
  };
}
