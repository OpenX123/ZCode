import type {
  AppUsageHeatmapCell,
  AppUsageHeatmapWeek,
  LocalUsageDailyPoint,
  LocalUsageModelRow,
  LocalUsageOrigin,
  LocalUsagePricingRow,
  LocalUsageProjectRow,
  LocalUsageRequest,
  LocalUsageRequestRow,
  LocalUsageSnapshot,
} from "@zcode/shared";
import type { LocalUsageIndex } from "./localUsageScanner.js";
import type { LocalLogEntry } from "./logEntries.js";
import {
  computeCostUsd,
  normalizeModelId,
  resolveModelPrice,
  type PricingTables,
} from "./modelPricing.js";

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 53;
const MAX_ALL_RANGE_DAYS = 400;
const REQUEST_ROW_LIMIT = 200;
const PROJECT_ROW_LIMIT = 100;

type Engine = "zcode" | "claude-code" | "codex";

/** 聚合用的统一用量行：日志请求一条一行；ZCode 原生为按日聚合行（timestamp 为 null）。 */
interface UsageRow {
  origin: LocalUsageOrigin;
  engine: Engine;
  launchedByZCode: boolean;
  date: string;
  timestamp: number | null;
  id: string | null;
  model: string;
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  requestCount: number;
}

export interface AggregateLocalUsageInput {
  index: LocalUsageIndex;
  request: LocalUsageRequest;
  timeZone: string;
  pricing: PricingTables;
  pricingSyncedAt: number | null;
  now: number;
}

function createDateKeyFormatter(timeZone: string): (ms: number) => string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // 时区偏移最小粒度为 15 分钟，按 15 分钟桶缓存，避免对每条请求都做一次 Intl 格式化。
  const memo = new Map<number, string>();
  return (ms) => {
    const bucket = Math.floor(ms / 900_000);
    const cached = memo.get(bucket);
    if (cached) return cached;
    const parts = formatter.formatToParts(new Date(ms));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
    const key = `${get("year")}-${get("month")}-${get("day")}`;
    memo.set(bucket, key);
    return key;
  };
}

function dateToDayIndex(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / DAY_MS);
}

function dayIndexToDate(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function totalTokensOf(row: UsageRow): number {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheReadTokens +
    row.cacheWrite5mTokens +
    row.cacheWrite1hTokens
  );
}

function buildRows(index: LocalUsageIndex, toDateKey: (ms: number) => string): UsageRow[] {
  const zcodeLaunched = new Set(
    index.externalSessions.map((item) => `${item.engine}:${item.externalSessionId}`),
  );
  const rows: UsageRow[] = [];
  const fromLog = (engine: "claude-code" | "codex", entry: LocalLogEntry, ordinal: number) => {
    const launchedByZCode = entry.sessionId !== null && zcodeLaunched.has(`${engine}:${entry.sessionId}`);
    rows.push({
      origin: launchedByZCode
        ? engine === "claude-code"
          ? "zcode-claude-code"
          : "zcode-codex"
        : engine === "claude-code"
          ? "claude-code-cli"
          : "codex-cli",
      engine,
      launchedByZCode,
      date: toDateKey(entry.timestamp),
      timestamp: entry.timestamp,
      id: entry.dedupKey ?? `${engine}:${entry.timestamp}:${ordinal}`,
      model: normalizeModelId(entry.model),
      cwd: entry.cwd,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWrite5mTokens: entry.cacheWrite5mTokens,
      cacheWrite1hTokens: entry.cacheWrite1hTokens,
      requestCount: 1,
    });
  };
  index.claudeEntries.forEach((entry, i) => fromLog("claude-code", entry, i));
  index.codexEntries.forEach((entry, i) => fromLog("codex", entry, i));
  for (const fact of index.zcodeFacts) {
    // model_usage.input_tokens 为含缓存的总输入；计价前拆出未缓存部分。
    const uncached = Math.max(0, fact.inputTokens - fact.cacheReadTokens - fact.cacheCreationTokens);
    rows.push({
      origin: "zcode",
      engine: "zcode",
      launchedByZCode: true,
      date: fact.date,
      timestamp: null,
      id: null,
      model: normalizeModelId(fact.modelId),
      cwd: fact.cwd,
      inputTokens: uncached,
      outputTokens: fact.outputTokens,
      cacheReadTokens: fact.cacheReadTokens,
      cacheWrite5mTokens: fact.cacheCreationTokens,
      cacheWrite1hTokens: 0,
      requestCount: fact.requestCount,
    });
  }
  return rows;
}

function matchesSource(row: UsageRow, source: LocalUsageRequest["source"]): boolean {
  switch (source) {
    case "all":
      return true;
    case "zcode":
      return row.launchedByZCode;
    case "claude-code":
      return row.engine === "claude-code";
    case "codex":
      return row.engine === "codex";
  }
}

export function resolveLocalUsageDateRange(
  request: Pick<LocalUsageRequest, "range" | "customStartDate" | "customEndDate">,
  today: string,
): { startDate: string | null; endDate: string } {
  const todayIndex = dateToDayIndex(today);
  switch (request.range) {
    case "today":
      return { startDate: today, endDate: today };
    case "7d":
      return { startDate: dayIndexToDate(todayIndex - 6), endDate: today };
    case "30d":
      return { startDate: dayIndexToDate(todayIndex - 29), endDate: today };
    case "all":
      return { startDate: null, endDate: today };
    case "custom": {
      const start = request.customStartDate ?? dayIndexToDate(todayIndex - 6);
      const end = request.customEndDate ?? today;
      return start <= end ? { startDate: start, endDate: end } : { startDate: end, endDate: start };
    }
  }
}

function buildHeatmapWeeks(rows: UsageRow[], today: string): AppUsageHeatmapWeek[] {
  const todayIndex = dateToDayIndex(today);
  const weekday = new Date(todayIndex * DAY_MS).getUTCDay();
  const startIndex = todayIndex - weekday - (HEATMAP_WEEKS - 1) * 7;
  const byDate = new Map<string, { tokens: number; requests: number }>();
  for (const row of rows) {
    const dayIndex = dateToDayIndex(row.date);
    if (dayIndex < startIndex || dayIndex > todayIndex) continue;
    const current = byDate.get(row.date) ?? { tokens: 0, requests: 0 };
    current.tokens += totalTokensOf(row);
    current.requests += row.requestCount;
    byDate.set(row.date, current);
  }
  const max = Math.max(0, ...[...byDate.values()].map((value) => value.tokens));
  const level = (tokens: number): AppUsageHeatmapCell["level"] => {
    if (tokens <= 0 || max <= 0) return 0;
    const ratio = tokens / max;
    return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
  };
  return Array.from({ length: HEATMAP_WEEKS }, (_, weekIndex) => ({
    weekIndex,
    days: Array.from({ length: 7 }, (_, dayOffset) => {
      const dayIndex = startIndex + weekIndex * 7 + dayOffset;
      if (dayIndex > todayIndex) return null;
      const date = dayIndexToDate(dayIndex);
      const value = byDate.get(date) ?? { tokens: 0, requests: 0 };
      return {
        date,
        level: level(value.tokens),
        totalTokens: value.tokens,
        turnCount: value.requests,
        toolCallCount: 0,
      };
    }),
  }));
}

/** 纯函数：把扫描索引按请求（来源/范围）聚合成快照。 */
export function aggregateLocalUsage(input: AggregateLocalUsageInput): LocalUsageSnapshot {
  const { index, request, pricing } = input;
  const toDateKey = createDateKeyFormatter(input.timeZone);
  const today = toDateKey(input.now);
  const allRows = buildRows(index, toDateKey).filter((row) => matchesSource(row, request.source));
  const { startDate, endDate } = resolveLocalUsageDateRange(request, today);
  const rows = allRows.filter(
    (row) => (startDate === null || row.date >= startDate) && row.date <= endDate,
  );

  const priceCache = new Map<string, ReturnType<typeof resolveModelPrice>>();
  const priceOf = (model: string) => {
    if (!priceCache.has(model)) priceCache.set(model, resolveModelPrice(model, pricing));
    return priceCache.get(model) ?? null;
  };
  const costOf = (row: UsageRow): number | null => {
    const resolved = priceOf(row.model);
    return resolved ? computeCostUsd(row, resolved.price) : null;
  };

  const summary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    costUsd: 0,
    unpricedTokens: 0,
    cacheHitRate: 0,
  };
  const daily = new Map<string, LocalUsageDailyPoint>();
  const models = new Map<string, LocalUsageModelRow & { priced: boolean }>();
  const projects = new Map<string, LocalUsageProjectRow>();
  const requestRows: Array<{ row: UsageRow; cost: number | null }> = [];

  for (const row of rows) {
    const tokens = totalTokensOf(row);
    const cost = costOf(row);
    const cacheWrite = row.cacheWrite5mTokens + row.cacheWrite1hTokens;
    summary.inputTokens += row.inputTokens;
    summary.outputTokens += row.outputTokens;
    summary.cacheReadTokens += row.cacheReadTokens;
    summary.cacheWriteTokens += cacheWrite;
    summary.totalTokens += tokens;
    summary.requestCount += row.requestCount;
    if (cost === null) summary.unpricedTokens += tokens;
    else summary.costUsd += cost;

    const day = daily.get(row.date) ?? { date: row.date, totalTokens: 0, requestCount: 0, costUsd: 0 };
    day.totalTokens += tokens;
    day.requestCount += row.requestCount;
    day.costUsd += cost ?? 0;
    daily.set(row.date, day);

    const model = models.get(row.model) ?? {
      modelId: row.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      costUsd: 0,
      share: 0,
      priced: cost !== null,
    };
    model.inputTokens += row.inputTokens;
    model.outputTokens += row.outputTokens;
    model.cacheReadTokens += row.cacheReadTokens;
    model.cacheWriteTokens += cacheWrite;
    model.totalTokens += tokens;
    model.requestCount += row.requestCount;
    model.costUsd = (model.costUsd ?? 0) + (cost ?? 0);
    models.set(row.model, model);

    const projectKey = row.cwd ?? "";
    const project = projects.get(projectKey) ?? {
      cwd: row.cwd,
      totalTokens: 0,
      requestCount: 0,
      costUsd: 0,
      lastActiveDate: null,
    };
    project.totalTokens += tokens;
    project.requestCount += row.requestCount;
    project.costUsd += cost ?? 0;
    if (!project.lastActiveDate || row.date > project.lastActiveDate) project.lastActiveDate = row.date;
    projects.set(projectKey, project);

    if (row.timestamp !== null) requestRows.push({ row, cost });
  }
  const inputSide = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  summary.cacheHitRate = inputSide > 0 ? summary.cacheReadTokens / inputSide : 0;

  // 趋势：范围内按日连续补 0；“全部”从最早有数据的日期开始（最多 400 天）。
  const endIndex = dateToDayIndex(endDate);
  const firstDataIndex = rows.length
    ? Math.min(...[...daily.keys()].map(dateToDayIndex))
    : endIndex;
  const startIndex =
    startDate !== null
      ? dateToDayIndex(startDate)
      : Math.max(firstDataIndex, endIndex - (MAX_ALL_RANGE_DAYS - 1));
  const dailySeries: LocalUsageDailyPoint[] = [];
  for (let dayIndex = startIndex; dayIndex <= endIndex; dayIndex += 1) {
    const date = dayIndexToDate(dayIndex);
    dailySeries.push(daily.get(date) ?? { date, totalTokens: 0, requestCount: 0, costUsd: 0 });
  }

  const modelRows = [...models.values()]
    .map(({ priced, ...model }) => ({
      ...model,
      costUsd: priced ? model.costUsd : null,
      share: summary.totalTokens > 0 ? model.totalTokens / summary.totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  requestRows.sort((a, b) => (b.row.timestamp ?? 0) - (a.row.timestamp ?? 0));
  const requests: LocalUsageRequestRow[] = requestRows
    .slice(0, REQUEST_ROW_LIMIT)
    .map(({ row, cost }) => ({
      id: row.id ?? "",
      timestamp: row.timestamp ?? 0,
      origin: row.origin,
      modelId: row.model,
      cwd: row.cwd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWrite5mTokens + row.cacheWrite1hTokens,
      costUsd: cost,
    }));

  const pricingModels = new Set([...models.keys(), ...Object.keys(pricing.manual)]);
  const pricingRows: LocalUsagePricingRow[] = [...pricingModels]
    .map((modelId) => {
      const resolved = priceOf(modelId);
      return {
        modelId,
        price: resolved?.price ?? null,
        origin: resolved?.origin ?? null,
        used: models.has(modelId),
      };
    })
    .sort(
      (a, b) =>
        Number(b.used) - Number(a.used) ||
        (models.get(b.modelId)?.totalTokens ?? 0) - (models.get(a.modelId)?.totalTokens ?? 0) ||
        a.modelId.localeCompare(b.modelId),
    );

  return {
    generatedAt: input.now,
    timeZone: input.timeZone,
    source: request.source,
    range: request.range,
    startDate: startDate ?? (rows.length ? dayIndexToDate(startIndex) : null),
    endDate,
    summary,
    daily: dailySeries,
    heatmapWeeks: buildHeatmapWeeks(allRows, today),
    models: modelRows,
    projects: [...projects.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, PROJECT_ROW_LIMIT),
    requests,
    requestTotal: requestRows.length,
    pricing: pricingRows,
    pricingSyncedAt: input.pricingSyncedAt,
    scan: {
      claudeFiles: index.claudeFiles,
      codexFiles: index.codexFiles,
      malformedLines: index.malformedLines,
      zcodeNativeAvailable: index.zcodeNativeAvailable,
      scannedAt: index.scannedAt,
      durationMs: index.durationMs,
    },
  };
}
