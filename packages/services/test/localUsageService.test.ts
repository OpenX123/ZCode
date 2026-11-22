import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot } from "@zcode/shared";
import { resolveLocalUsageDateRange } from "../src/usage-stats/local/localUsageAggregator.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";

const FIXTURES = join(__dirname, "fixtures", "local-usage");
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: { cliAvailable?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-local-usage-svc-"));
  tempDirs.push(root);
  const project = join(root, "home", ".claude", "projects", "-work-alpha");
  const codexDay = join(root, "home", ".codex", "sessions", "2026", "11", "21");
  await mkdir(project, { recursive: true });
  await mkdir(codexDay, { recursive: true });
  await copyFile(join(FIXTURES, "claude-session.jsonl"), join(project, "sess-cli.jsonl"));
  await copyFile(join(FIXTURES, "claude-resumed.jsonl"), join(project, "sess-zcode.jsonl"));
  await copyFile(join(FIXTURES, "codex-rollout.jsonl"), join(codexDay, "rollout.jsonl"));
  const getAppUsageStats = vi.fn(async () => {
    if (options.cliAvailable === false) throw new Error("no_active_workspace");
    return {
      usageFacts: [
        {
          date: "2026-11-22",
          modelId: "glm-4.6",
          cwd: "/work/native",
          inputTokens: 1_000,
          outputTokens: 100,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 600,
          requestCount: 4,
        },
      ],
      externalSessions: [{ engine: "claude-code", externalSessionId: "sess-zcode" }],
    } as unknown as AppUsageSnapshot;
  });
  const fetch = vi.fn<typeof globalThis.fetch>();
  const service = createUsageStatsService({
    zcodeAgentService: { getAppUsageStats },
    localUsage: {
      env: { HOME: join(root, "home") },
      dataDir: join(root, "data"),
      fetch,
      now: () => NOW,
    },
  });
  return { service, getAppUsageStats, fetch };
}

describe("本机多来源用量快照", () => {
  it("全部来源只计一次，ZCode 启动的 Claude 会话标为 ZCode（LU-07）", async () => {
    const { service, fetch } = await setup();
    const snapshot = await service.getLocalUsageSnapshot({
      source: "all",
      range: "all",
      timeZone: "UTC",
    });
    // Claude 3（msg_1 去重）+ Codex 2 + ZCode 原生 4
    expect(snapshot.summary.requestCount).toBe(9);
    expect(snapshot.requests.map((r) => r.origin)).toEqual(
      expect.arrayContaining(["zcode-claude-code", "claude-code-cli", "codex-cli"]),
    );
    // msg_1 首次出现在 sess-cli，去重后保留的是带 stop_reason 的一条
    expect(snapshot.requestTotal).toBe(5);
    expect(snapshot.scan.zcodeNativeAvailable).toBe(true);
    expect(snapshot.models.map((m) => m.modelId)).toEqual(
      expect.arrayContaining(["claude-sonnet-4.5", "claude-opus-4.5", "gpt-5.1-codex", "glm-4.6"]),
    );
    expect(snapshot.heatmapWeeks).toHaveLength(53);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("来源筛选：ZCode 含原生与 ZCode 启动的会话，Claude Code 含全部 Claude 日志", async () => {
    const { service } = await setup();
    const zcode = await service.getLocalUsageSnapshot({
      source: "zcode",
      range: "all",
      timeZone: "UTC",
    });
    expect(zcode.summary.requestCount).toBe(4 + 1);
    expect(new Set(zcode.requests.map((r) => r.origin))).toEqual(new Set(["zcode-claude-code"]));
    const claude = await service.getLocalUsageSnapshot({
      source: "claude-code",
      range: "all",
      timeZone: "UTC",
    });
    expect(claude.summary.requestCount).toBe(3);
    const codex = await service.getLocalUsageSnapshot({
      source: "codex",
      range: "all",
      timeZone: "UTC",
    });
    expect(codex.summary).toMatchObject({
      requestCount: 2,
      outputTokens: 150,
      cacheReadTokens: 1100,
    });
  });

  it("ZCode 原生 input 为含缓存总量，计价时拆出未缓存输入", async () => {
    const { service } = await setup();
    const snapshot = await service.getLocalUsageSnapshot({
      source: "zcode",
      range: "today",
      timeZone: "UTC",
    });
    expect(snapshot.summary).toMatchObject({
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 100,
      requestCount: 4,
    });
    expect(snapshot.summary.cacheHitRate).toBeCloseTo(0.6);
    // glm-4.6: 400*0.6 + 100*2.2 + 600*0.11 per 1M
    expect(snapshot.summary.costUsd).toBeCloseTo((400 * 0.6 + 100 * 2.2 + 600 * 0.11) / 1e6, 10);
    expect(snapshot.requests).toEqual([]);
    expect(snapshot.daily).toEqual([
      expect.objectContaining({ date: "2026-11-22", requestCount: 4 }),
    ]);
  });

  it("时间范围：7d 连续补 0，自定义范围按自然日过滤", async () => {
    const { service } = await setup();
    const week = await service.getLocalUsageSnapshot({
      source: "all",
      range: "7d",
      timeZone: "UTC",
    });
    expect(week.daily).toHaveLength(7);
    expect(week.startDate).toBe("2026-11-16");
    const custom = await service.getLocalUsageSnapshot({
      source: "all",
      range: "custom",
      customStartDate: "2026-11-20",
      customEndDate: "2026-11-20",
      timeZone: "UTC",
    });
    expect(custom.summary.requestCount).toBe(2);
    expect(
      resolveLocalUsageDateRange(
        { range: "custom", customStartDate: "2026-11-10", customEndDate: "2026-11-01" },
        "2026-11-22",
      ),
    ).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-10",
    });
  });

  it("CLI 不可用时仍统计日志，并标记原生不可用（LU-08）", async () => {
    const { service } = await setup({ cliAvailable: false });
    const snapshot = await service.getLocalUsageSnapshot({
      source: "all",
      range: "all",
      timeZone: "UTC",
    });
    expect(snapshot.scan.zcodeNativeAvailable).toBe(false);
    expect(snapshot.summary.requestCount).toBe(5);
    expect(snapshot.requests.every((r) => r.origin !== "zcode-claude-code")).toBe(true);
  });

  it("手动改价、恢复默认与手动同步价格（LU-10）", async () => {
    const { service, fetch } = await setup();
    await service.setModelPriceOverride({
      modelId: "GLM-4.6",
      price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    let snapshot = await service.getLocalUsageSnapshot({
      source: "zcode",
      range: "today",
      timeZone: "UTC",
    });
    expect(snapshot.pricing.find((p) => p.modelId === "glm-4.6")?.origin).toBe("manual");
    expect(snapshot.summary.costUsd).toBeCloseTo(1100 / 1e6, 10);

    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          zai: { models: { "glm-4.6": { cost: { input: 2, output: 2, cache_read: 2 } } } },
        }),
      ),
    );
    await expect(service.syncModelPrices()).resolves.toEqual({ syncedAt: NOW, modelCount: 1 });
    expect(fetch).toHaveBeenCalledWith("https://models.dev/api.json", expect.anything());
    await service.setModelPriceOverride({ modelId: "glm-4.6", price: null });
    snapshot = await service.getLocalUsageSnapshot({
      source: "zcode",
      range: "today",
      timeZone: "UTC",
    });
    expect(snapshot.pricing.find((p) => p.modelId === "glm-4.6")?.origin).toBe("synced");
    expect(snapshot.pricingSyncedAt).toBe(NOW);
  });

  it("拒绝非法请求参数", async () => {
    const { service } = await setup();
    await expect(
      service.getLocalUsageSnapshot({ source: "bogus", range: "all" } as never),
    ).rejects.toThrow();
  });
});
