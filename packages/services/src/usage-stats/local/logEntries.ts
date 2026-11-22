import { z } from "zod";

/**
 * 从 Claude Code / Codex 日志解析出的一次模型请求（纯数据，可写入缓存）。
 * inputTokens 为未缓存输入；缓存读/写单独计。规则见 docs/usage-stats-local-sources.md §4。
 */
export interface LocalLogEntry {
  timestamp: number;
  model: string;
  sessionId: string | null;
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** 跨文件去重键；null 表示不去重。 */
  dedupKey: string | null;
  /** Claude：该行是否带 stop_reason（同 message.id 多行时优先）。 */
  final: boolean;
}

export type LineParseResult = LocalLogEntry | "skip" | "malformed";

const count = z.number().finite().nonnegative().catch(0).optional();

const claudeAssistantLineSchema = z.object({
  type: z.literal("assistant"),
  timestamp: z.string(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  requestId: z.string().optional(),
  message: z.object({
    id: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullish(),
    usage: z.object({
      input_tokens: count,
      output_tokens: count,
      cache_read_input_tokens: count,
      cache_creation_input_tokens: count,
      cache_creation: z
        .object({
          ephemeral_5m_input_tokens: count,
          ephemeral_1h_input_tokens: count,
        })
        .nullish(),
    }),
  }),
});

function parseTimestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 只解析 type=assistant 且带 message.usage 的行；其余行 skip。 */
export function parseClaudeLine(line: string, fallbackSessionId: string | null): LineParseResult {
  // 预过滤：大体积 tool_result 行不做 JSON.parse。
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return "skip";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "malformed";
  }
  if (!raw || typeof raw !== "object" || (raw as { type?: unknown }).type !== "assistant") {
    return "skip";
  }
  const parsed = claudeAssistantLineSchema.safeParse(raw);
  if (!parsed.success) return "malformed";
  const { message } = parsed.data;
  if (message.model === "<synthetic>") return "skip";
  const timestamp = parseTimestamp(parsed.data.timestamp);
  if (timestamp === null) return "malformed";
  const usage = message.usage;
  const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
  const cacheWrite1h = Math.min(
    cacheWriteTotal || Number.POSITIVE_INFINITY,
    usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  );
  const entry: LocalLogEntry = {
    timestamp,
    model: message.model ?? "unknown",
    sessionId: parsed.data.sessionId ?? fallbackSessionId,
    cwd: parsed.data.cwd ?? null,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: Math.max(0, cacheWriteTotal - cacheWrite1h),
    cacheWrite1hTokens: cacheWrite1h,
    dedupKey: message.id
      ? parsed.data.requestId
        ? `${message.id}:${parsed.data.requestId}`
        : message.id
      : null,
    final: message.stop_reason != null,
  };
  if (
    entry.inputTokens +
      entry.outputTokens +
      entry.cacheReadTokens +
      entry.cacheWrite5mTokens +
      entry.cacheWrite1hTokens ===
    0
  ) {
    return "skip";
  }
  return entry;
}

/** 同去重键多行时的取舍：优先带 stop_reason 的行，否则取 output 更大者。 */
export function preferClaudeEntry(current: LocalLogEntry, candidate: LocalLogEntry): LocalLogEntry {
  if (candidate.final !== current.final) return candidate.final ? candidate : current;
  return candidate.outputTokens > current.outputTokens ? candidate : current;
}

// ── Codex ────────────────────────────────────────────────────────────

/** Codex 增量解析需要跨行保存的状态（随文件游标一起持久化）。 */
export interface CodexParserState {
  threadId: string | null;
  cwd: string | null;
  model: string | null;
  lastTotal: CodexTokenUsage | null;
  lastSignature: string | null;
}

export const codexParserStateSchema = z.object({
  threadId: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  lastTotal: z
    .object({
      input: z.number(),
      cached: z.number(),
      output: z.number(),
      reasoning: z.number(),
      total: z.number(),
    })
    .nullable(),
  lastSignature: z.string().nullable(),
});

export interface CodexTokenUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

export function createCodexParserState(): CodexParserState {
  return { threadId: null, cwd: null, model: null, lastTotal: null, lastSignature: null };
}

const CODEX_FALLBACK_MODEL = "gpt-5";

const codexUsageSchema = z
  .object({
    input_tokens: count,
    cached_input_tokens: count,
    output_tokens: count,
    reasoning_output_tokens: count,
    total_tokens: count,
  })
  .nullish();

const codexLineSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      cwd: z.string().optional(),
      model: z.string().optional(),
      info: z
        .object({
          total_token_usage: codexUsageSchema,
          last_token_usage: codexUsageSchema,
          model: z.string().optional(),
        })
        .nullish(),
    })
    .passthrough()
    .optional(),
});

function toCodexUsage(raw: z.infer<typeof codexUsageSchema>): CodexTokenUsage | null {
  if (!raw) return null;
  return {
    input: raw.input_tokens ?? 0,
    cached: raw.cached_input_tokens ?? 0,
    output: raw.output_tokens ?? 0,
    reasoning: raw.reasoning_output_tokens ?? 0,
    total: raw.total_tokens ?? 0,
  };
}

function subtractUsage(
  current: CodexTokenUsage,
  previous: CodexTokenUsage | null,
): CodexTokenUsage {
  // 总量回退（新会话/重置）时取当次总量，避免负数。
  if (!previous || current.total < previous.total || current.input < previous.input) return current;
  return {
    input: current.input - previous.input,
    cached: Math.max(0, current.cached - previous.cached),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    total: current.total - previous.total,
  };
}

/** 有状态地解析一行 Codex 日志；state 会被原地更新。 */
export function parseCodexLine(line: string, state: CodexParserState): LineParseResult {
  if (
    !line.includes("token_count") &&
    !line.includes("turn_context") &&
    !line.includes("session_meta")
  ) {
    return "skip";
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "malformed";
  }
  const parsed = codexLineSchema.safeParse(raw);
  if (!parsed.success) return "malformed";
  const { type, payload, timestamp } = parsed.data;
  if (type === "session_meta") {
    state.threadId = payload?.id ?? state.threadId;
    state.cwd = payload?.cwd ?? state.cwd;
    return "skip";
  }
  if (type === "turn_context") {
    state.model = payload?.model ?? state.model;
    state.cwd = payload?.cwd ?? state.cwd;
    return "skip";
  }
  if (type !== "event_msg" || payload?.type !== "token_count") return "skip";
  const info = payload.info;
  if (!info) return "skip";
  const total = toCodexUsage(info.total_token_usage);
  const last = toCodexUsage(info.last_token_usage);
  const signature = JSON.stringify([total, last]);
  if (signature === state.lastSignature) return "skip";
  state.lastSignature = signature;
  const delta = last ?? (total ? subtractUsage(total, state.lastTotal) : null);
  if (total) state.lastTotal = total;
  if (!delta) return "skip";
  const ts = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(ts)) return "malformed";
  const cached = Math.min(delta.cached, delta.input);
  if (delta.input + delta.output === 0) return "skip";
  return {
    timestamp: ts,
    model: info.model ?? state.model ?? CODEX_FALLBACK_MODEL,
    sessionId: state.threadId,
    cwd: state.cwd,
    inputTokens: delta.input - cached,
    outputTokens: delta.output,
    cacheReadTokens: cached,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    // fork 复制历史事件时时间戳与总量不变，用它们跨文件去重。
    dedupKey: `${timestamp}:${total ? JSON.stringify(total) : JSON.stringify(last)}`,
    final: true,
  };
}
