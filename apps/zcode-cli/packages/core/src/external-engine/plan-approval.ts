import type {
  ExternalEnginePermissionOption,
  ExternalEnginePermissionOutcome,
  ExternalEnginePermissionRequest,
  PermissionBrokerResult,
} from "@zcode/contracts";
import type { NativePermissionOption } from "@zcode/shared/zcode-protocol-v4";

// 原生计划审批的识别与选项映射（docs/desktop/native-plan-errors-spec.md「Claude 计划审批识别与选项」）。
// 纯函数：只读 ACP 请求与 Runtime 已记住的模式值，不触碰会话状态。

const PLAN_REVIEW_TOOL_CALL_PREFIX = "plan-review:";
const SWITCH_MODE_KIND = "switch_mode";
const EXIT_PLAN_MODE_TOOL_NAME = "exitplanmode";
// claude-agent-acp 0.95.0 tool-calls/reporters/interaction.js 的 ExitPlanMode 标题。
const CLAUDE_APPROVE_PLAN_TITLE = "approve plan";
// claude-agent-acp permissions/options/shared.js 的退出计划选项 ID。
const CLAUDE_EXIT_PLAN_DEFAULT_OPTION_ID = "exit-plan-default";
const CLAUDE_EXIT_PLAN_OPTION_BY_MODE: Readonly<Record<string, string>> = {
  auto: "exit-plan-auto",
  bypassPermissions: "exit-plan-bypass",
  acceptEdits: "exit-plan-accept-edits",
  default: CLAUDE_EXIT_PLAN_DEFAULT_OPTION_ID,
};
const CLEAR_CONTEXT_OPTION_ID = /^exit-plan-clear-/;
const CLEAR_CONTEXT_OPTION_NAME = /\bclear context\b/i;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 计划审批请求：Codex `plan-review:*`；Claude 的 ExitPlanMode 只在非标准 `name` 字段带工具名、
 * 标题为 "Approve Plan" 且无 `_meta.claudeCode.toolName`，按名称、标题或计划输入识别。
 */
export function isExternalPlanApproval(request: ExternalEnginePermissionRequest): boolean {
  const toolCall = request.toolCall;
  const rawInput = record(toolCall.rawInput);
  if (
    String(toolCall.toolCallId).startsWith(PLAN_REVIEW_TOOL_CALL_PREFIX) &&
    toolCall.kind === SWITCH_MODE_KIND &&
    typeof rawInput.plan === "string"
  )
    return true;
  const nativeName = record(record(toolCall._meta).claudeCode).toolName ?? toolCall.name;
  if (
    typeof nativeName === "string" &&
    nativeName.trim().toLowerCase() === EXIT_PLAN_MODE_TOOL_NAME
  )
    return true;
  const title = typeof toolCall.title === "string" ? toolCall.title.trim().toLowerCase() : "";
  // 旧 adapter 曾把工具名放在标题里。
  if (title === EXIT_PLAN_MODE_TOOL_NAME) return true;
  if (toolCall.kind !== SWITCH_MODE_KIND) return false;
  return (
    title === CLAUDE_APPROVE_PLAN_TITLE ||
    typeof rawInput.plan === "string" ||
    typeof rawInput.planFilePath === "string"
  );
}

export function clearsPlanContext(option: ExternalEnginePermissionOption): boolean {
  return (
    CLEAR_CONTEXT_OPTION_ID.test(option.optionId) || CLEAR_CONTEXT_OPTION_NAME.test(option.name)
  );
}

function isAllow(option: ExternalEnginePermissionOption): boolean {
  return option.kind === "allow_once" || option.kind === "allow_always";
}

/**
 * 主按钮“开始执行”：保留上下文并回到进入计划前的权限模式；映射项缺失时回退
 * “manually approve edits”，再回退首个非清空上下文的 allow 项。从不选择清空上下文项。
 */
export function recommendedPlanOption(
  request: ExternalEnginePermissionRequest,
  prePlanMode: string | undefined,
): ExternalEnginePermissionOption | undefined {
  const allows = request.options.filter((option) => isAllow(option) && !clearsPlanContext(option));
  const preferred = prePlanMode ? CLAUDE_EXIT_PLAN_OPTION_BY_MODE[prePlanMode] : undefined;
  return (
    allows.find((option) => option.optionId === preferred) ??
    allows.find((option) => option.optionId === CLAUDE_EXIT_PLAN_DEFAULT_OPTION_ID) ??
    allows.find((option) => option.kind === "allow_once") ??
    allows[0]
  );
}

export function nativePlanOptions(
  request: ExternalEnginePermissionRequest,
  recommended: ExternalEnginePermissionOption | undefined,
): NativePermissionOption[] {
  return request.options.map((option) => ({
    optionId: option.optionId,
    label: option.name,
    kind: option.kind,
    ...(option.optionId === recommended?.optionId ? { recommended: true } : {}),
    ...(clearsPlanContext(option) ? { clearsContext: true } : {}),
  }));
}

/**
 * 回传精确原生 optionId：用户显式选择且与决策一致时原样使用（含“更多”里的清空上下文项）；
 * 否则 allow 取推荐项、deny 取 reject 项。旧客户端只回 allow/deny 时走同一回退。
 */
export function selectPlanApprovalOutcome(
  request: ExternalEnginePermissionRequest,
  result: Pick<PermissionBrokerResult, "decision" | "nativeOptionId">,
  recommended: ExternalEnginePermissionOption | undefined,
): ExternalEnginePermissionOutcome {
  const allow = result.decision === "allow";
  const chosen = request.options.find((option) => option.optionId === result.nativeOptionId);
  if (chosen && isAllow(chosen) === allow)
    return { outcome: "selected", optionId: chosen.optionId };
  if (allow)
    return recommended
      ? { outcome: "selected", optionId: recommended.optionId }
      : { outcome: "cancelled" };
  const reject =
    request.options.find((option) => option.kind === "reject_once") ??
    request.options.find((option) => option.kind === "reject_always");
  return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}
