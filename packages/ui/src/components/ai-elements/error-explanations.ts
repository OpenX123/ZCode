/**
 * 常见失败的人话归类（docs/desktop/native-plan-errors-spec.md「1.5.0 外观」）。
 * 纯函数：只读已在 ACP adapter / V4 投影边界脱敏的 HTTP 状态、错误码、错误源与消息，
 * 不新增协议字段；归类不到时返回 undefined，由调用方显示原摘要。
 */
export type ErrorExplanationKind =
  | "auth"
  | "forbidden"
  | "rateLimit"
  | "overloaded"
  | "timeout"
  | "network"
  | "contextTooLong";

export interface ErrorExplanationInput {
  httpStatus?: number;
  code?: string;
  source?: string;
  message?: string;
  summary?: string;
}

const STATUS_KINDS: ReadonlyMap<number, ErrorExplanationKind> = new Map([
  [401, "auth"],
  [403, "forbidden"],
  [429, "rateLimit"],
  [529, "overloaded"],
  [503, "overloaded"],
  [408, "timeout"],
  [504, "timeout"],
]);

// 顺序即优先级：上下文过长的报错常带 400，需先于泛化的鉴权/网络词匹配。
const TEXT_PATTERNS: readonly (readonly [ErrorExplanationKind, RegExp])[] = [
  [
    "contextTooLong",
    /context[_ ]?(length|window)|prompt is too long|too many tokens|maximum context|context_length_exceeded/i,
  ],
  ["rateLimit", /rate[_ -]?limit|too many requests/i],
  ["overloaded", /overloaded/i],
  ["auth", /unauthori[sz]ed|invalid[_ ]api[_ ]?key|authentication/i],
  ["forbidden", /forbidden|permission[_ ]denied/i],
  ["timeout", /timed? ?out|timeout|ETIMEDOUT/i],
  [
    "network",
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed|socket hang up|network (error|is unreachable)/i,
  ],
];

export function classifyErrorExplanation(
  input: ErrorExplanationInput,
): ErrorExplanationKind | undefined {
  if (input.httpStatus !== undefined) {
    const byStatus = STATUS_KINDS.get(input.httpStatus);
    if (byStatus) return byStatus;
  }
  const text = [input.code, input.message, input.summary].filter(Boolean).join("\n");
  if (text) {
    for (const [kind, pattern] of TEXT_PATTERNS) if (pattern.test(text)) return kind;
  }
  return input.source === "network" ? "network" : undefined;
}

export function errorExplanationTitleId(kind: ErrorExplanationKind): string {
  return `chat.error.explain.${kind}.title`;
}

export function errorExplanationHintId(kind: ErrorExplanationKind): string {
  return `chat.error.explain.${kind}.hint`;
}
