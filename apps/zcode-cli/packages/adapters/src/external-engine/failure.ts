import type { ExternalEngineFailureNotice } from "@zcode/contracts";
import {
  engineConnectionFailureSchema,
  isRetryableHttpStatus,
  readExternalEngineFailure,
  type EngineConnectionFailure,
} from "@zcode/shared";

// ACP 失败归一的唯一边界（docs/desktop/native-plan-errors-spec.md「失败来源与归一」）：
// typed sessionFailure、Codex 非 typed `_meta.codex.error` 与 prompt 响应里的终态失败都在此脱敏，
// 原始 title/details/message 不越过 adapter。
type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** JetBrains AIR 失败扩展的客户端声明；只声明失败能力，不声明子会话等其他能力。 */
export const AIR_SESSION_FAILURE_CAPABILITY_META = {
  jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } },
} as const;

const FAILURE_ID_MAX_CHARS = 200;
// "Reconnecting... 2/5"（Codex）与 "Retrying Claude, attempt 2 of 10."（Claude）。
const RETRY_PROGRESS_PATTERNS: readonly RegExp[] = [
  /\battempt\s+(\d+)\s+of\s+(\d+)\b/i,
  /\b(?:reconnecting|retrying)\b[^\d]{0,24}(\d+)\s*\/\s*(\d+)\b/i,
];
const RETRY_ORDINAL_PATTERN = /\b(?:reconnecting|retrying)\b[^\d]{0,24}(\d+)\b/i;

export function readRetryProgress(
  text: unknown,
): Pick<EngineConnectionFailure, "attempt" | "maxAttempts"> {
  if (typeof text !== "string") return {};
  for (const pattern of RETRY_PROGRESS_PATTERNS) {
    const match = pattern.exec(text);
    const attempt = Number(match?.[1]);
    const maxAttempts = Number(match?.[2]);
    if (Number.isInteger(attempt) && attempt > 0 && Number.isInteger(maxAttempts))
      return maxAttempts >= attempt ? { attempt, maxAttempts } : { attempt };
  }
  const attempt = Number(RETRY_ORDINAL_PATTERN.exec(text)?.[1]);
  return Number.isInteger(attempt) && attempt > 0 ? { attempt } : {};
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= FAILURE_ID_MAX_CHARS
    ? value
    : undefined;
}

function withDiagnostics(
  failure: EngineConnectionFailure,
  extra: Partial<EngineConnectionFailure>,
): EngineConnectionFailure {
  const merged = { ...failure };
  for (const [key, value] of Object.entries(extra))
    if (value !== undefined) (merged as JsonObject)[key] = value;
  return engineConnectionFailureSchema.parse(merged);
}

/** `_meta.jetbrains.air.sessionFailure`：{id, revision, category, severity, title, details?, actions}。 */
export function readAirSessionFailure(meta: unknown): ExternalEngineFailureNotice | undefined {
  const value = record(record(record(record(meta).jetbrains).air).sessionFailure);
  const severity = value.severity;
  if ((severity !== "warning" && severity !== "error") || typeof value.title !== "string")
    return undefined;
  const failure = readExternalEngineFailure(
    {
      message: value.title,
      ...(typeof value.details === "string" ? { additionalDetails: value.details } : {}),
    },
    {
      // access 是登录/凭据类阻断；其他类别都是网关或供应商侧失败，连接本身仍健康。
      code: value.category === "access" ? "authentication" : "provider",
      method: "session/prompt",
    },
  );
  const actions = Array.isArray(value.actions) ? value.actions : [];
  return {
    severity,
    ...(typeof value.revision === "number" && Number.isInteger(value.revision)
      ? { revision: value.revision }
      : {}),
    failure: withDiagnostics(failure, {
      ...(severity === "warning" ? readRetryProgress(value.title) : {}),
      failureId: boundedId(value.id),
      retryable:
        failure.httpStatus !== undefined
          ? isRetryableHttpStatus(failure.httpStatus)
          : actions.includes("retry"),
    }),
  };
}

/**
 * Codex 未声明 typed failure 时的回退：`_meta.codex.error` 的 message 是 "Reconnecting… n/m"，
 * 状态行在 additionalDetails，HTTP 状态在 codexErrorInfo.*.httpStatusCode。
 */
export function readCodexErrorMeta(meta: unknown): ExternalEngineFailureNotice | undefined {
  const error = record(record(record(meta).codex).error);
  if (typeof error.message !== "string") return undefined;
  const retrying = error.willRetry === true;
  const failure = readExternalEngineFailure(error, {
    code: "provider",
    method: "session/prompt",
  });
  const turnId = boundedId(error.turnId);
  return {
    severity: retrying ? "warning" : "error",
    failure: withDiagnostics(failure, {
      ...(retrying ? readRetryProgress(error.message) : {}),
      failureId: turnId ? `${turnId}:error` : undefined,
    }),
  };
}

/** session_info_update 的失败元数据；typed 优先，其次 Codex 回退形态。 */
export function readSessionInfoFailure(
  update: JsonObject,
): ExternalEngineFailureNotice | undefined {
  if (update.sessionUpdate !== "session_info_update") return undefined;
  return readAirSessionFailure(update._meta) ?? readCodexErrorMeta(update._meta);
}

/** prompt 响应 `_meta.jetbrains.air.sessionFailure`（severity=error）即本轮终态失败。 */
export function readPromptResultFailure(result: JsonObject): EngineConnectionFailure | undefined {
  const notice = readAirSessionFailure(result._meta);
  return notice?.severity === "error" ? notice.failure : undefined;
}
