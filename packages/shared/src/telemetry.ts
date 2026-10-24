import { redactTelemetryText } from "./telemetryRedaction.js";

const MAX_TELEMETRY_SKILL_NAME_LENGTH = 64;
const TELEMETRY_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * 只用于已解析的 Skill 名称，不能据此信任模型请求参数。
 * 不 trim 或截断，以免把敏感文本残片变成看似合法的标识。
 */
export function sanitizeTelemetrySkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TELEMETRY_SKILL_NAME_LENGTH ||
    !TELEMETRY_SKILL_NAME_PATTERN.test(value) ||
    redactTelemetryText(value) !== value
  ) {
    return "unknown";
  }
  return value;
}
