import type { TurnActivityState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStallInput } from "./contract.js";

const T0 = 1_700_000_000_000;

const waitingModelActivity = {
  turnId: "turn-1",
  lastActivityAt: T0,
  phaseStartedAt: T0,
  activityPhase: { kind: "waiting_model" },
} satisfies TurnActivityState;

const runningToolActivity = {
  turnId: "turn-1",
  lastActivityAt: T0,
  phaseStartedAt: T0,
  activityPhase: { kind: "running_tool", toolName: "Bash", toolCallId: "call-1" },
} satisfies TurnActivityState;

/** 等待模型 6 分钟无输出：应升级为警告。 */
export const stalledWaitingModelExample = {
  turnActivity: waitingModelActivity,
  running: true,
  hasPendingInteraction: false,
  nowMs: T0 + 6 * 60_000,
} satisfies ConversationStallInput;

/** 工具执行 10 分钟：不视为无响应，不出提示条（耗时由工具行显示）。 */
export const longRunningToolExample = {
  turnActivity: runningToolActivity,
  running: true,
  hasPendingInteraction: false,
  nowMs: T0 + 10 * 60_000,
} satisfies ConversationStallInput;
