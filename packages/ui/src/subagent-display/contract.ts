import type {
  AgentFaceSize,
  AgentFaceVariant,
} from "@/components/workflow-timeline/WorkflowAgentFace.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";

/** 轮廓变体（按子智能体类型）；颜色只按实例序号，见 docs/desktop/multi-agent-display-spec.md。 */
export type SubagentFaceVariant = AgentFaceVariant;
export type SubagentFaceSize = AgentFaceSize;

/** 各展示面共用的状态词表；颜色从不表达它，只由表情、图标与文字表达。 */
export type SubagentDisplayStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface SubagentStatusCounts {
  /** pending / running / waiting / blocked。 */
  running: number;
  done: number;
  failed: number;
  cancelled: number;
}

/** 由父会话 `snapshot.subagents.childSessionIds` 派生的序号表；不缓存、不持久化。 */
export interface SubagentAvatarIndex {
  /** 去重后的清单长度，也是未登记成员临时序号的起点。 */
  readonly size: number;
  indexOf(childSessionId: string | null | undefined): number | undefined;
}

export interface SubagentFaceProps {
  avatarIndex: number | undefined;
  /** 用于散列兜底的名字（只在序号缺席时生效）。 */
  name: string;
  subagentType?: string | null;
  status: SubagentDisplayStatus | undefined;
  size: SubagentFaceSize;
  /** 运行中详情头部之外都静止。 */
  animated?: boolean;
  ringed?: boolean;
  className?: string;
}

export interface SubagentSessionHeaderModel {
  avatarIndex: number | undefined;
  variant: SubagentFaceVariant;
  status: SubagentDisplayStatus | undefined;
  startedAt?: number;
  endedAt?: number;
  /** 父会话可停的 backgroundWork；缺席即不显示停止。 */
  stopWorkId?: string;
  /** W8：子智能体模型（展示用 ID）与思考档位；只有投影带值时出现。 */
  model?: string;
  effort?: string;
}

/**
 * 工作卡按子会话读取的父会话运行态（docs/desktop/multi-agent-display-spec.md「停止」）：
 * `liveStatus` 来自 `snapshot.subagents.running`（waiting / blocked 的唯一来源），
 * `cancellableWorkId` 来自精确匹配、`cancellable !== false` 的 running backgroundWork。
 * 内容不变时由 `useSubagentWorkLiveIndex` 保持引用稳定，避免整条时间线重渲染。
 */
export interface SubagentWorkLiveEntry {
  liveStatus?: "running" | "waiting" | "blocked";
  cancellableWorkId?: string;
}
export type SubagentWorkLiveIndex = ReadonlyMap<string, SubagentWorkLiveEntry>;

/** 可进入派发行的成员：已配对的 Agent 卡，或尚未配对的 Agent/Task 工具行。 */
export type AgentSpawnMemberItem =
  | Extract<ConversationAssistantWorkRenderItem, { kind: "agentToolCall" }>
  | Extract<ConversationAssistantWorkRenderItem, { kind: "row" }>;

/**
 * 同一轮相邻派发合并后的一项；身份锚定首个成员。
 * `workCard`：任一成员已有子会话，1 个或多个成员渲染为 Subagent 工作卡；
 * `sentence`：都没有子会话且 ≥2 个，渲染为旧的"A、B 和 C 开始工作"行。
 */
export interface AgentSpawnGroupRenderItem {
  kind: "agentSpawnGroup";
  presentation: "workCard" | "sentence";
  key: string;
  rowId: number;
  turnId: string;
  members: AgentSpawnMemberItem[];
}

export type ConversationAssistantWorkDisplayItem =
  | ConversationAssistantWorkRenderItem
  | AgentSpawnGroupRenderItem;
