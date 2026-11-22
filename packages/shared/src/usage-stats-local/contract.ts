import { z } from "zod";

// 本机多来源用量（ZCode 原生 / Claude Code / Codex 日志）。
// 规则与所有者见 docs/usage-stats-local-sources.md；RPC 两端都用这里的 schema 做运行时校验。

export const LOCAL_USAGE_SOURCES = ["all", "zcode", "claude-code", "codex"] as const;
export type LocalUsageSource = (typeof LOCAL_USAGE_SOURCES)[number];

export const LOCAL_USAGE_RANGES = ["today", "7d", "30d", "all", "custom"] as const;
export type LocalUsageRange = (typeof LOCAL_USAGE_RANGES)[number];

/** 单条请求的来源标签：launcher（谁启动）× engine（谁产生 token）。 */
export const LOCAL_USAGE_ORIGINS = [
  "zcode",
  "zcode-claude-code",
  "zcode-codex",
  "claude-code-cli",
  "codex-cli",
] as const;
export type LocalUsageOrigin = (typeof LOCAL_USAGE_ORIGINS)[number];

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// 与 AppUsageHeatmapWeek 同形（结构类型兼容，可直接交给既有热力图组件）；本模块保持自包含、不反向依赖 shared 根。
const localUsageHeatmapWeekSchema = z.object({
  weekIndex: z.number(),
  days: z.array(
    z
      .object({
        date: z.string(),
        level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        totalTokens: z.number(),
        /** 本机多来源统计中表示请求数。 */
        turnCount: z.number(),
        toolCallCount: z.number(),
      })
      .nullable(),
  ),
});
const nonNegative = z.number().finite().nonnegative();

export const localUsageRequestSchema = z
  .object({
    source: z.enum(LOCAL_USAGE_SOURCES),
    range: z.enum(LOCAL_USAGE_RANGES),
    customStartDate: dateKeySchema.nullish(),
    customEndDate: dateKeySchema.nullish(),
    timeZone: z.string().optional(),
  })
  .strict();
export type LocalUsageRequest = z.infer<typeof localUsageRequestSchema>;

export const modelPriceSchema = z
  .object({
    input: nonNegative,
    output: nonNegative,
    cacheRead: nonNegative,
    cacheWrite: nonNegative,
    /** Claude 1h 缓存写入单价；缺省时按 cacheWrite 计。 */
    cacheWrite1h: nonNegative.optional(),
  })
  .strict();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const MODEL_PRICE_ORIGINS = ["builtin", "synced", "manual"] as const;
export type ModelPriceOrigin = (typeof MODEL_PRICE_ORIGINS)[number];

export const setModelPriceOverrideRequestSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    price: modelPriceSchema.nullable(),
  })
  .strict();
export type SetModelPriceOverrideRequest = z.infer<typeof setModelPriceOverrideRequestSchema>;

export const modelPriceSyncResultSchema = z.object({
  syncedAt: z.number(),
  modelCount: z.number().int().nonnegative(),
});
export type ModelPriceSyncResult = z.infer<typeof modelPriceSyncResultSchema>;

const tokenBreakdownShape = {
  inputTokens: nonNegative,
  outputTokens: nonNegative,
  cacheReadTokens: nonNegative,
  cacheWriteTokens: nonNegative,
  totalTokens: nonNegative,
};

export const localUsageSummarySchema = z.object({
  ...tokenBreakdownShape,
  requestCount: nonNegative,
  /** 已定价部分的估算费用（USD）。 */
  costUsd: nonNegative,
  /** 没有价格的模型产生的 token 数；>0 时 UI 提示费用不完整。 */
  unpricedTokens: nonNegative,
  cacheHitRate: z.number().min(0).max(1),
});
export type LocalUsageSummary = z.infer<typeof localUsageSummarySchema>;

export const localUsageDailyPointSchema = z.object({
  date: dateKeySchema,
  totalTokens: nonNegative,
  requestCount: nonNegative,
  costUsd: nonNegative,
});
export type LocalUsageDailyPoint = z.infer<typeof localUsageDailyPointSchema>;

export const localUsageModelRowSchema = z.object({
  modelId: z.string(),
  ...tokenBreakdownShape,
  requestCount: nonNegative,
  costUsd: nonNegative.nullable(),
  share: z.number().min(0).max(1),
});
export type LocalUsageModelRow = z.infer<typeof localUsageModelRowSchema>;

export const localUsageProjectRowSchema = z.object({
  cwd: z.string().nullable(),
  totalTokens: nonNegative,
  requestCount: nonNegative,
  costUsd: nonNegative,
  lastActiveDate: dateKeySchema.nullable(),
});
export type LocalUsageProjectRow = z.infer<typeof localUsageProjectRowSchema>;

export const localUsageRequestRowSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  origin: z.enum(LOCAL_USAGE_ORIGINS),
  modelId: z.string(),
  cwd: z.string().nullable(),
  inputTokens: nonNegative,
  outputTokens: nonNegative,
  cacheReadTokens: nonNegative,
  cacheWriteTokens: nonNegative,
  costUsd: nonNegative.nullable(),
});
export type LocalUsageRequestRow = z.infer<typeof localUsageRequestRowSchema>;

export const localUsagePricingRowSchema = z.object({
  modelId: z.string(),
  price: modelPriceSchema.nullable(),
  origin: z.enum(MODEL_PRICE_ORIGINS).nullable(),
  /** 当前范围内是否有用量；定价 tab 优先展示。 */
  used: z.boolean(),
});
export type LocalUsagePricingRow = z.infer<typeof localUsagePricingRowSchema>;

export const localUsageScanInfoSchema = z.object({
  claudeFiles: z.number().int().nonnegative(),
  codexFiles: z.number().int().nonnegative(),
  malformedLines: z.number().int().nonnegative(),
  zcodeNativeAvailable: z.boolean(),
  scannedAt: z.number(),
  durationMs: nonNegative,
});
export type LocalUsageScanInfo = z.infer<typeof localUsageScanInfoSchema>;

export const localUsageSnapshotSchema = z.object({
  generatedAt: z.number(),
  timeZone: z.string(),
  source: z.enum(LOCAL_USAGE_SOURCES),
  range: z.enum(LOCAL_USAGE_RANGES),
  startDate: dateKeySchema.nullable(),
  endDate: dateKeySchema,
  summary: localUsageSummarySchema,
  daily: z.array(localUsageDailyPointSchema),
  /** 最近 53 个自然周，受来源筛选影响、不受时间范围影响；turnCount 表示请求数。 */
  heatmapWeeks: z.array(localUsageHeatmapWeekSchema),
  models: z.array(localUsageModelRowSchema),
  projects: z.array(localUsageProjectRowSchema),
  requests: z.array(localUsageRequestRowSchema),
  requestTotal: z.number().int().nonnegative(),
  pricing: z.array(localUsagePricingRowSchema),
  pricingSyncedAt: z.number().nullable(),
  scan: localUsageScanInfoSchema,
});
export type LocalUsageSnapshot = z.infer<typeof localUsageSnapshotSchema>;
