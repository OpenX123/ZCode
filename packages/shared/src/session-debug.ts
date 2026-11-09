import { z } from "zod";

export const SESSION_DEBUG_LIMITS = { rounds: 200, network: 100, dedupe: 2000 } as const;
export const sessionDebugParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();
const count = z.number().finite().nonnegative();
const debugUsageSchema = z
  .object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    totalTokens: count.optional(),
    reasoningTokens: count.optional(),
    cachedInputTokens: count.optional(),
    cachedWriteInputTokens: count.optional(),
  })
  .strict();
export const sessionDebugRoundSchema = z
  .object({
    eventKey: z.string(),
    requestId: z.string(),
    requestIndex: count,
    recordedAt: count,
    usage: debugUsageSchema,
    hitRate: count.nullable(),
    generationDurationMs: count.nullable(),
    tokensPerSecond: count.nullable(),
  })
  .strict();
export const sessionDebugNetworkEntrySchema = z
  .object({
    eventKey: z.string(),
    traceId: z.string(),
    recordedAt: count,
    statusType: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    requestId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    providerKind: z.string().optional(),
    transport: z.string().optional(),
    baseURL: z.string().optional(),
    querySource: z.string().optional(),
    queryId: z.string().optional(),
    timestamp: z.string().optional(),
    attempt: count.optional(),
    maxAttempts: count.optional(),
    nextAttempt: count.optional(),
    retryable: z.boolean().optional(),
    statusCode: count.optional(),
    durationMs: count.optional(),
    delayMs: count.optional(),
    idleMs: count.optional(),
    timeoutMs: count.optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestHeaderCount: count,
    responseHeaderCount: count,
  })
  .strict();
export const sessionDebugSnapshotSchema = z
  .object({
    sessionId: z.string(),
    rounds: z.array(sessionDebugRoundSchema).max(SESSION_DEBUG_LIMITS.rounds),
    networkEntries: z.array(sessionDebugNetworkEntrySchema).max(SESSION_DEBUG_LIMITS.network),
    cache: z
      .object({
        hitRateRequestCount: count,
        totalInputTokens: count,
        totalCacheReadTokens: count,
        hitRate: count.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SessionDebugSnapshot = z.infer<typeof sessionDebugSnapshotSchema>;
export type SessionDebugNetworkEntry = z.infer<typeof sessionDebugNetworkEntrySchema>;

/** 输出 token 与首输出到请求结束的同源时间；未知值不能用请求总耗时替代。 */
export function calculateOutputTps(
  outputTokens: number | undefined,
  generationDurationMs: number | null,
): number | null {
  if (
    outputTokens === undefined ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    generationDurationMs === null ||
    !Number.isFinite(generationDurationMs) ||
    generationDurationMs <= 0
  )
    return null;
  const tps = (outputTokens * 1000) / generationDurationMs;
  return Number.isFinite(tps) ? tps : null;
}

/** 单次物理模型请求的输出计时事实（来自 model_request_completed）。 */
export interface ModelCallOutputTiming {
  outputTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  timeToFirstContentMs?: number;
  /** 是否流式收到过非空推理 delta；undefined 表示旧事件未记录。 */
  reasoningContentStreamed?: boolean;
}

export interface ModelCallOutputRate {
  /** 落在生成时长内的输出 token（隐藏推理已扣除）。 */
  streamedOutputTokens: number;
  generationMs: number;
}

export interface TurnOutputRate {
  outputTps: number;
  generationMs: number;
  firstTokenMs: number;
}

function finiteNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/**
 * 逐调用口径（docs/desktop/turn-output-rate-spec.md §2）：生成时长 = 总时长 − 首字时间；
 * 隐藏推理发生在首字之前，分子扣除推理 token；无法判断时返回 null，不估算。
 */
export function calculateModelCallOutputRate(
  call: ModelCallOutputTiming,
): ModelCallOutputRate | null {
  const { outputTokens, reasoningTokens, durationMs, timeToFirstContentMs } = call;
  if (
    !finiteNonNegative(outputTokens) ||
    !finiteNonNegative(durationMs) ||
    !finiteNonNegative(timeToFirstContentMs)
  )
    return null;
  const generationMs = durationMs - timeToFirstContentMs;
  if (generationMs <= 0) return null;
  let streamedOutputTokens = outputTokens;
  if (reasoningTokens !== undefined && reasoningTokens !== 0) {
    if (!finiteNonNegative(reasoningTokens)) return null;
    // 旧事件没有推理是否流式的标记，无法判断推理是否在生成时长内。
    if (call.reasoningContentStreamed === undefined) return null;
    if (!call.reasoningContentStreamed) streamedOutputTokens = outputTokens - reasoningTokens;
  }
  if (streamedOutputTokens < 0) return null;
  return { streamedOutputTokens, generationMs };
}

/** 整轮 tokens/s = Σ分子 ÷ Σ生成时长；没有调用或任何一次缺数据时返回 null。 */
export function aggregateTurnOutputRate(
  calls: readonly ModelCallOutputTiming[],
): TurnOutputRate | null {
  const first = calls[0];
  if (!first || !finiteNonNegative(first.timeToFirstContentMs)) return null;
  let tokens = 0;
  let generationMs = 0;
  for (const call of calls) {
    const rate = calculateModelCallOutputRate(call);
    if (!rate) return null;
    tokens += rate.streamedOutputTokens;
    generationMs += rate.generationMs;
  }
  const outputTps = calculateOutputTps(tokens, generationMs);
  if (outputTps === null) return null;
  return { outputTps, generationMs, firstTokenMs: first.timeToFirstContentMs };
}
