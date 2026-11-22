import type { TurnActivityState } from "@zcode/shared/zcode-protocol-v4";

/** UI 派生的无响应状态；事实来源只有 runtime 下发的 `snapshot.turnActivity`。 */
export type ConversationStallState =
  | { kind: "none" }
  | { kind: "idle"; level: "hint" | "warning"; idleMinutes: number }
  | { kind: "tool"; toolName: string; elapsedMinutes: number };

export interface ConversationStallInput {
  turnActivity: TurnActivityState | null | undefined;
  /** `snapshot.control.phase === "running"`。 */
  running: boolean;
  /** 存在待处理审批/提问时等待的是用户，不提示无响应。 */
  hasPendingInteraction: boolean;
  nowMs: number;
}

export interface ConversationStallNoticeProps {
  turnActivity: TurnActivityState | null | undefined;
  running: boolean;
  hasPendingInteraction: boolean;
  /** `ENGINE_LABELS` 中的引擎显示名。 */
  engineLabel: string;
  /** 缺省时隐藏“中断并重试”（找不到可重发的用户输入）。 */
  onInterruptAndRetry?: () => void;
  onInterrupt: () => void;
  /** 缺省时隐藏“查看日志”（平台不支持导出日志）。 */
  onViewLogs?: () => void;
}
