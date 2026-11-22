import type {
  ConversationStallInput,
  ConversationStallState,
  RunningToolActivity,
} from "./contract.js";

/** 无输出 ≥60s 显示提示。 */
export const STALL_HINT_AFTER_MS = 60_000;
/** 无输出 ≥5min 升级为警告并提供中断/重试。 */
export const STALL_WARNING_AFTER_MS = 5 * 60_000;
/** 分钟级文案无需逐秒刷新；5s tick 让越过阈值后的显示延迟不超过 5s（提示条与工具行共用）。 */
export const STALL_TICK_MS = 5_000;
/** 工具行耗时同样 ≥60s 才显示。 */
export const TOOL_ELAPSED_VISIBLE_AFTER_MS = STALL_HINT_AFTER_MS;

const NONE: ConversationStallState = { kind: "none" };

function toMinutes(ms: number): number {
  return Math.max(1, Math.floor(ms / 60_000));
}

/**
 * 纯派生：只读 runtime 的 turnActivity，不保存第二份活动时间。不自动中断或重试。
 *
 * Bug 修复（1.5.1）：1.5.0 对 running_tool 也返回 `tool` 提示，渲染成独立的
 * “正在执行 Bash，已 1 分钟”，与正上方运行中工具行“正在执行 curl …”重复，且用的是 runtime
 * 原始工具名。running_tool 现在一律不出提示条，耗时改由命中的工具行尾显示
 * （`resolveRunningToolActivity` + `useRunningToolElapsedLabel`）。
 */
export function resolveConversationStallState(
  input: ConversationStallInput,
): ConversationStallState {
  const { turnActivity, running, hasPendingInteraction, nowMs } = input;
  if (!running || !turnActivity || hasPendingInteraction) return NONE;
  if (turnActivity.activityPhase.kind === "running_tool") return NONE;
  const idleMs = nowMs - turnActivity.lastActivityAt;
  if (idleMs < STALL_HINT_AFTER_MS) return NONE;
  return {
    kind: "idle",
    level: idleMs >= STALL_WARNING_AFTER_MS ? "warning" : "hint",
    idleMinutes: toMinutes(idleMs),
  };
}

/** 当前运行工具；非运行、有待处理交互、非 running_tool 或缺少 toolCallId 时为 null。 */
export function resolveRunningToolActivity(
  input: Omit<ConversationStallInput, "nowMs">,
): RunningToolActivity | null {
  const { turnActivity, running, hasPendingInteraction } = input;
  if (!running || !turnActivity || hasPendingInteraction) return null;
  const phase = turnActivity.activityPhase;
  if (phase.kind !== "running_tool" || !phase.toolCallId) return null;
  return { toolCallId: phase.toolCallId, phaseStartedAt: turnActivity.phaseStartedAt };
}

/** 工具行耗时分钟数；未满 60s 返回 null。 */
export function runningToolElapsedMinutes(phaseStartedAt: number, nowMs: number): number | null {
  const elapsedMs = nowMs - phaseStartedAt;
  return elapsedMs >= TOOL_ELAPSED_VISIBLE_AFTER_MS ? toMinutes(elapsedMs) : null;
}
