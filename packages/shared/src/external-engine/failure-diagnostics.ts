import { z } from "zod";
import { redactFeedbackText } from "../feedbackPrivacy.js";

// 失败诊断的脱敏规则只有这一处：ACP adapter（外部引擎）与 V4 投影（内置引擎重试）共用，
// 规则见 docs/desktop/native-plan-errors-spec.md「失败来源与归一」。

export const FAILURE_MESSAGE_MAX_CHARS = 300;
export const FAILURE_URL_MAX_CHARS = 512;
export const FAILURE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;
export const FAILURE_URL_PATTERN = /^https?:\/\/[^\s?#]+$/;

const REDACTED = "[REDACTED]";
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>),]+/gi;
// 令牌形态：Bearer 头、常见前缀密钥，以及 key=value 形式的凭据赋值。
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|sess|key|rk|pk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',;&]+/gi,
];
// 请求/响应正文不是错误摘要；只截掉明确以字段名引出的正文。
const BODY_FIELD = /\b(?:body|payload|response|prompt|messages)\s*[:=]/i;
const HTTP_STATUS_IN_TEXT =
  /\b(?:HTTP(?:\/\d(?:\.\d)?)?(?:\s+status)?|status(?:\s+code)?|API\s+Error)\s*[:=]?\s*(\d{3})\b/i;
const REQUEST_ID_IN_TEXT = /request[ _-]?id["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/i;

/** 仅保留 scheme + host + path；userinfo、query 与 fragment 一律丢弃。 */
export function reduceFailureUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const path = url.pathname === "/" ? "" : redactSecrets(url.pathname);
  const reduced = `${url.protocol}//${url.host}${path}`;
  return reduced.length <= FAILURE_URL_MAX_CHARS && FAILURE_URL_PATTERN.test(reduced)
    ? reduced
    : undefined;
}

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

/**
 * 上游原文首行：去 HTML 标签、URL 收窄为 scheme + host + path、凭据与令牌脱敏，最多 300 字。
 * 返回 undefined 表示没有可展示的安全文本。
 */
export function sanitizeFailureMessage(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const head = firstLine.split(BODY_FIELD, 1)[0]!;
  const withoutTags = head.replace(/<[^>]*>/g, " ");
  // 已收窄的 URL 是可展示事实；通用脱敏会把路径当作本地路径整段抹掉，先占位再还原。
  const urls: string[] = [];
  const masked = withoutTags.replace(URL_IN_TEXT, (match) => {
    const reduced = reduceFailureUrl(match);
    if (!reduced) return "[URL]";
    urls.push(reduced);
    return `⟦URL${urls.length - 1}⟧`;
  });
  const redacted = redactSecrets(redactFeedbackText(masked, { diagnostic: true })).replace(
    /⟦URL(\d+)⟧/g,
    (_match, index: string) => urls[Number(index)] ?? "[URL]",
  );
  const message = redacted.replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_MAX_CHARS).trim();
  return message || undefined;
}

/** 文本中的首个合法 HTTP 状态（"status 502"、"HTTP 502"、"API Error: 502"）。 */
export function readFailureHttpStatus(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const parsed = Number(HTTP_STATUS_IN_TEXT.exec(text)?.[1]);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/** 结构化字段优先；否则读取上游文本里的 "request id: …" 或 JSON 的 "request_id"。 */
export function readFailureRequestId(value: unknown, text?: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : typeof text === "string"
        ? REQUEST_ID_IN_TEXT.exec(text)?.[1]
        : undefined;
  return typeof raw === "string" && FAILURE_REQUEST_ID_PATTERN.test(raw) ? raw : undefined;
}

/** 文本中的首个 http(s) URL，收窄后返回。 */
export function readFailureUrl(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const reduced = reduceFailureUrl(match[0]);
    if (reduced) return reduced;
  }
  return undefined;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 安全诊断在输入边界脱敏，仅保留有界摘要与白名单协议字段。 */
export const engineConnectionFailureSchema = z.object({
  code: z.enum([
    "not_ready",
    "authentication",
    "session_not_found",
    "unsupported",
    "configuration",
    "timeout",
    "transport",
    "request",
    "protocol",
    "provider",
  ]),
  method: z
    .enum([
      "initialize",
      "session/new",
      "session/fork",
      "session/resume",
      "session/load",
      "session/set_config_option",
      "session/prompt",
      "providers/set",
    ])
    .optional(),
  rpcCode: z.number().int().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  message: z.string().max(320).optional(),
  requestId: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .optional(),
  retryable: z.boolean().optional(),
  // 以下为 2026-11 additive 诊断：原生展示的第 n 次重试与上限、仅含 scheme+host+path 的 URL、
  // adapter 失败 ID（同一轮重试与终态共用，供幂等合并）。旧事件缺省时仍可解析。
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  url: z.string().max(FAILURE_URL_MAX_CHARS).regex(FAILURE_URL_PATTERN).optional(),
  failureId: z.string().min(1).max(200).optional(),
});
export type EngineConnectionFailure = z.infer<typeof engineConnectionFailureSchema>;

/**
 * 外部错误可能夹带认证 URL 与响应正文；同一边界同时用于 RPC 和流中诊断。
 * Codex 的重试把 "Reconnecting… n/m" 放在 message、把状态行放在 additionalDetails，
 * 两者都读，摘要优先取包含上游原因的 details。
 */
export function readExternalEngineFailure(
  value: unknown,
  base: EngineConnectionFailure = { code: "request" },
): EngineConnectionFailure {
  const record = (item: unknown): Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
  const source = record(value);
  const data = record(source.data);
  const info = record(source.codexErrorInfo ?? data.codexErrorInfo);
  const details = Object.values(info).map(record);
  const text = (candidate: unknown) =>
    typeof candidate === "string" && candidate.trim() ? candidate : undefined;
  const summaryText = text(source.message) ?? text(data.message) ?? "";
  const detailText =
    text(source.additionalDetails) ?? text(data.additionalDetails) ?? text(source.details);
  const allText = [detailText, summaryText].filter(Boolean).join("\n");
  const rawStatus =
    source.httpStatus ??
    data.httpStatus ??
    details.find((entry) => typeof entry.httpStatusCode === "number")?.httpStatusCode;
  const parsedStatus =
    typeof rawStatus === "number" ? rawStatus : readFailureHttpStatus(allText.replace(/\n/g, " "));
  const httpStatus =
    parsedStatus !== undefined &&
    Number.isInteger(parsedStatus) &&
    parsedStatus >= 100 &&
    parsedStatus <= 599
      ? parsedStatus
      : undefined;
  const requestId = readFailureRequestId(source.requestId ?? data.requestId, allText);
  const url = readFailureUrl(allText);
  const message = sanitizeFailureMessage(detailText ?? summaryText);
  return engineConnectionFailureSchema.parse({
    ...base,
    ...(httpStatus
      ? {
          httpStatus,
          code: httpStatus === 401 || httpStatus === 403 ? "authentication" : "provider",
          retryable: isRetryableHttpStatus(httpStatus),
        }
      : {}),
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
    ...(url ? { url } : {}),
  });
}
