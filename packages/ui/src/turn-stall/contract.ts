import type { ReactNode } from "react";
import type { TurnActivityState } from "@zcode/shared/zcode-protocol-v4";

/**
 * UI 派生的无响应状态；事实来源只有 runtime 下发的 `snapshot.turnActivity`。
 * 1.5.1 起 `running_tool` 不再派生独立提示，耗时改由运行中工具行显示（`RunningToolActivity`）。
 */
export type ConversationStallState =
  | { kind: "none" }
  | { kind: "idle"; level: "hint" | "warning"; idleMinutes: number };

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

/** 当前运行中的前台工具（由 `turnActivity.activityPhase` 派生），供工具行显示耗时。 */
export interface RunningToolActivity {
  toolCallId: string;
  /** `turnActivity.phaseStartedAt`：该工具成为当前运行工具的时间（epoch ms）。 */
  phaseStartedAt: number;
}

export interface RunningToolActivityProviderProps {
  turnActivity: TurnActivityState | null | undefined;
  running: boolean;
  hasPendingInteraction: boolean;
  /** 只读会话不显示耗时。 */
  disabled?: boolean;
  children?: ReactNode;
}
