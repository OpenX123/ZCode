import type { ConversationStallInput, ConversationStallState } from "./contract.js";

/** 无输出 ≥60s 显示提示。 */
export const STALL_HINT_AFTER_MS = 60_000;
/** 无输出 ≥5min 升级为警告并提供中断/重试。 */
export const STALL_WARNING_AFTER_MS = 5 * 60_000;

const NONE: ConversationStallState = { kind: "none" };

function toMinutes(ms: number): number {
  return Math.max(1, Math.floor(ms / 60_000));
}

/**
 * 纯派生：只读 runtime 的 turnActivity，不保存第二份活动时间。
 * running_tool 不视为无响应，只在执行 ≥60s 时显示工具耗时；不自动中断或重试。
 */
export function resolveConversationStallState(
  input: ConversationStallInput,
): ConversationStallState {
  const { turnActivity, running, hasPendingInteraction, nowMs } = input;
  if (!running || !turnActivity || hasPendingInteraction) return NONE;
  const phase = turnActivity.activityPhase;
  if (phase.kind === "running_tool") {
    const elapsedMs = nowMs - turnActivity.phaseStartedAt;
    return elapsedMs >= STALL_HINT_AFTER_MS
      ? { kind: "tool", toolName: phase.toolName, elapsedMinutes: toMinutes(elapsedMs) }
      : NONE;
  }
  const idleMs = nowMs - turnActivity.lastActivityAt;
  if (idleMs < STALL_HINT_AFTER_MS) return NONE;
  return {
    kind: "idle",
    level: idleMs >= STALL_WARNING_AFTER_MS ? "warning" : "hint",
    idleMinutes: toMinutes(idleMs),
  };
}
