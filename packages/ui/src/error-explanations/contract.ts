/** 常见失败归类的公开类型（docs/desktop/native-plan-errors-spec.md「1.5.0 外观」）。 */
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
