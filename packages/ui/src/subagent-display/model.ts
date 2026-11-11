/**
 * 多智能体展示的纯派生（docs/desktop/multi-agent-display-spec.md）。
 *
 * 全部输入都是 CLI 投影（父会话 `snapshot.subagents` / `backgroundWorks` / 时间线行，子会话
 * `control` / 行窗口），这里不保存任何状态：同一投影永远得到同一结果，所以重渲染、重连和冷恢复
 * 后头像序号、状态都不会漂移。
 */
import type {
  BackgroundWorkSummary,
  RowsWindow,
  SessionControl,
  SubagentProjectionState,
  SubagentRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { buildSubagentControlWorkIndex } from "@/v4/conversationStatusPanelModel.js";
import type {
  SubagentAvatarIndex,
  SubagentDisplayStatus,
  SubagentFaceVariant,
  SubagentSessionHeaderModel,
  SubagentStatusCounts,
  SubagentWorkLiveEntry,
  SubagentWorkLiveIndex,
} from "./contract.js";

/** 父会话清单 → 序号表；重复 id 取首次出现，`size` 是去重后的成员数（临时序号的起点）。 */
export function buildSubagentAvatarIndex(
  childSessionIds: readonly string[] | undefined,
): SubagentAvatarIndex {
  const positions = new Map<string, number>();
  for (const childSessionId of childSessionIds ?? []) {
    if (!positions.has(childSessionId)) positions.set(childSessionId, positions.size);
  }
  return {
    size: positions.size,
    indexOf: (childSessionId) => (childSessionId ? positions.get(childSessionId) : undefined),
  };
}

/**
 * 一组成员的头像序号：已登记的取清单序号；尚未登记（子会话未到或引擎没有子会话）的按组内顺序
 * 从清单长度起编临时序号。临时序号恰好是"按工具调用顺序登记"时它们将得到的序号。
 */
export function resolveSubagentAvatarIndexes(
  index: SubagentAvatarIndex,
  childSessionIds: readonly (string | null | undefined)[],
): number[] {
  let provisional = index.size;
  return childSessionIds.map((childSessionId) => index.indexOf(childSessionId) ?? provisional++);
}

// 规则按"一个词"匹配，复合类型从最后一个词向前找（英文复合名的中心词在末尾：code-reviewer 是 reviewer）。
const VARIANT_RULES: ReadonlyArray<readonly [RegExp, SubagentFaceVariant]> = [
  [/^(explor|search|scout|find|locat)/, "antenna"],
  [/^(plan|architect)/, "visor"],
  [/^(review|verif|audit|critic|check|inspect)/, "glasses"],
  [/^(test|qa$|e2e$)/, "crest"],
  [/^(research|investigat|analy|study)/, "ears"],
];

/** 子智能体类型 → 轮廓变体；general-purpose、worker 与未知类型都是 `base`。 */
export function resolveSubagentFaceVariant(
  subagentType: string | null | undefined,
): SubagentFaceVariant {
  const tokens = (subagentType ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let position = tokens.length - 1; position >= 0; position -= 1) {
    const token = tokens[position]!;
    for (const [pattern, variant] of VARIANT_RULES) {
      if (pattern.test(token)) return variant;
    }
  }
  return "base";
}

/** 可见名称：标题/描述 → 类型 → 本地化"智能体 N"（调用方传入已格式化的兜底）。 */
export function subagentDisplayName({
  title,
  subagentType,
  fallbackName,
}: {
  title?: string | null;
  subagentType?: string | null;
  fallbackName: string;
}): string {
  // 通用引擎占位不是任务名；各展示面统一使用任务描述优先的规则。
  const type = subagentType?.trim();
  return title?.trim() || (type?.toLowerCase() !== "subagent" ? type : "") || fallbackName;
}

export type SubagentNameListPart =
  | { type: "element"; index: number }
  | { type: "literal"; value: string };

function listFormatter(locale: string) {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
}

/** 按语言连接名称（zh：A、B和C；en：A, B, and C）。 */
export function formatSubagentNameList(names: readonly string[], locale: string): string {
  return listFormatter(locale).format(names);
}

/** 同上，但返回片段：名称片段只给出输入下标，调用方在该位置渲染头像 + 名称按钮。 */
export function formatSubagentNameListParts(
  names: readonly string[],
  locale: string,
): SubagentNameListPart[] {
  let element = 0;
  return listFormatter(locale)
    .formatToParts(names)
    .map((part) =>
      part.type === "element"
        ? { type: "element" as const, index: element++ }
        : { type: "literal" as const, value: part.value },
    );
}

/**
 * 派发成员的状态：配对的 subagent 行是子智能体自身的状态（后台 Agent 的工具调用在启动后就成功，
 * 子智能体仍在运行）；没有配对行时只能读工具调用本身。
 */
export function resolveAgentSpawnStatus(
  row: Pick<ToolCallRow, "status">,
  subagentRow?: Pick<SubagentRow, "status"> | null,
): SubagentDisplayStatus {
  if (subagentRow) {
    if (subagentRow.status === "success") return "done";
    if (subagentRow.status === "failed") return "failed";
    if (subagentRow.status === "cancelled") return "cancelled";
    return "running";
  }
  switch (row.status) {
    case "inputStreaming":
    case "pendingApproval":
      return "pending";
    case "running":
      return "running";
    case "success":
      return "done";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** 展示状态 → 瓦片脸表情；停止与失败同为"未完成"的下垂眼，等待/阻塞仍是运行中的竖眼。 */
export function faceStatusOf(status: SubagentDisplayStatus | undefined): StepRunStatus | undefined {
  switch (status) {
    case undefined:
      return undefined;
    case "pending":
      return "pending";
    case "done":
      return "done";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "running";
  }
}

export function isSubagentStatusActive(status: SubagentDisplayStatus | undefined): boolean {
  return (
    status === "pending" || status === "running" || status === "waiting" || status === "blocked"
  );
}

export function summarizeSubagentStatuses(
  statuses: readonly SubagentDisplayStatus[],
): SubagentStatusCounts {
  const counts: SubagentStatusCounts = { running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const status of statuses) {
    if (isSubagentStatusActive(status)) counts.running += 1;
    else counts[status as "done" | "failed" | "cancelled"] += 1;
  }
  return counts;
}

function childControlStatus(
  control: Pick<SessionControl, "phase" | "lastError"> | null | undefined,
): SubagentDisplayStatus | undefined {
  if (!control) return undefined;
  if (control.phase === "running" || control.phase === "prewarming") return "running";
  if (control.phase === "error" || control.lastError) return "failed";
  if (control.phase === "completedInterrupted") return "cancelled";
  if (control.phase === "completedSuccess") return "done";
  return undefined;
}

/** 子会话自身的起止：只有行窗口已到顶（首行即全序首行）时，首个 turnHeader 才是真正的开始。 */
function childTurnSpan(rows: RowsWindow | null | undefined): {
  startedAt?: number;
  endedAt?: number;
} {
  const window = rows?.window ?? [];
  if (window.length === 0 || rows?.firstRowId !== window[0]!.rowId) return {};
  const headers = window.filter((row) => row.kind === "turnHeader");
  const first = headers[0];
  const last = headers.at(-1);
  if (!first || !last) return {};
  return {
    startedAt: first.startedAt,
    ...(last.endedAt !== undefined ? { endedAt: last.endedAt } : {}),
  };
}

/**
 * 右侧详情头部：运行态以父会话 `running` 为准（含 waiting / blocked），父会话不再列为运行中时
 * 以子会话 `control` 的结束态为准；停止只来自父会话可停的精确 backgroundWork。
 */
export function buildSubagentSessionHeaderModel({
  childSessionId,
  subagentType,
  parent,
  child,
}: {
  childSessionId: string;
  subagentType?: string;
  parent:
    | {
        subagents?: SubagentProjectionState | undefined;
        backgroundWorks?: readonly BackgroundWorkSummary[] | undefined;
        rows?: RowsWindow | undefined;
      }
    | null
    | undefined;
  child:
    | {
        control?: Pick<SessionControl, "phase" | "lastError"> | undefined;
        rows?: RowsWindow | undefined;
      }
    | null
    | undefined;
}): SubagentSessionHeaderModel {
  const manifest = parent?.subagents;
  const avatarIndex = manifest
    ? resolveSubagentAvatarIndexes(buildSubagentAvatarIndex(manifest.childSessionIds), [
        childSessionId,
      ])[0]
    : undefined;
  const running = manifest?.running.find((item) => item.childSessionId === childSessionId);
  const status = running?.status ?? childControlStatus(child?.control);
  const span = childTurnSpan(child?.rows);
  const startedAt = running?.startedAt ?? span.startedAt;
  const endedAt = isSubagentStatusActive(status) ? undefined : span.endedAt;
  const stopWorkId = resolveSubagentStopWorkId(
    cancellableSubagentWorkId(
      buildSubagentControlWorkIndex(parent?.backgroundWorks).get(childSessionId),
    ),
    status,
  );
  // 模型：运行中取父会话 running[]；结束后取父时间线中该子会话最后一个 subagent 行（W8）。
  const modelSource = running ?? latestSubagentRowOf(parent?.rows, childSessionId);
  return {
    avatarIndex,
    variant: resolveSubagentFaceVariant(running?.subagentType ?? subagentType),
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(stopWorkId ? { stopWorkId } : {}),
    ...(modelSource?.model ? { model: modelSource.model } : {}),
    ...(modelSource?.model && modelSource.effort ? { effort: modelSource.effort } : {}),
  };
}

function latestSubagentRowOf(
  rows: RowsWindow | null | undefined,
  childSessionId: string,
): SubagentRow | undefined {
  const window = rows?.window ?? [];
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const row = window[index]!;
    if (row.kind === "subagent" && row.childSessionId === childSessionId) return row;
  }
  return undefined;
}

/** 可停 work 的 workId：精确匹配（null 表示重复身份）且 `cancellable !== false`。 */
function cancellableSubagentWorkId(
  control: BackgroundWorkSummary | null | undefined,
): string | undefined {
  return control && control.cancellable !== false ? control.workId : undefined;
}

/**
 * 停止入口的唯一规则（详情头部与工作卡共用）：有可停 work 且成员仍在运行才给 workId，
 * 命令沿用父会话 `cancelBackgroundWork(workId)`（docs/desktop/multi-agent-display-spec.md「停止」）。
 */
export function resolveSubagentStopWorkId(
  cancellableWorkId: string | undefined,
  status: SubagentDisplayStatus | undefined,
): string | undefined {
  return cancellableWorkId && isSubagentStatusActive(status) ? cancellableWorkId : undefined;
}

/**
 * 父会话运行态 → 工作卡按子会话读取的索引：`running[]` 给 waiting / blocked，
 * 精确匹配的 backgroundWork 给可停 workId。纯函数；引用稳定由 `useSubagentWorkLiveIndex` 负责。
 */
export function buildSubagentWorkLiveIndex(
  subagents: SubagentProjectionState | null | undefined,
  backgroundWorks: readonly BackgroundWorkSummary[] | null | undefined,
): SubagentWorkLiveIndex {
  const index = new Map<string, SubagentWorkLiveEntry>();
  for (const item of subagents?.running ?? []) {
    index.set(item.childSessionId, { liveStatus: item.status });
  }
  for (const [childSessionId, control] of buildSubagentControlWorkIndex(
    backgroundWorks ?? undefined,
  )) {
    const cancellableWorkId = cancellableSubagentWorkId(control);
    if (!cancellableWorkId) continue;
    index.set(childSessionId, { ...index.get(childSessionId), cancellableWorkId });
  }
  return index;
}

/** 两份索引内容相同（用于保持 context 引用稳定，避免整条时间线重渲染）。 */
export function sameSubagentWorkLiveIndex(
  left: SubagentWorkLiveIndex,
  right: SubagentWorkLiveIndex,
): boolean {
  if (left.size !== right.size) return false;
  for (const [childSessionId, entry] of left) {
    const other = right.get(childSessionId);
    if (
      !other ||
      other.liveStatus !== entry.liveStatus ||
      other.cancellableWorkId !== entry.cancellableWorkId
    ) {
      return false;
    }
  }
  return true;
}

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/** 紧凑时长："58秒" / "1分 12秒" / "1小时 3分"（en："58s" / "1m 12s"）。 */
export function formatSubagentDuration(durationMs: number, formatMessage: FormatMessage): string {
  const total = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}${formatMessage({ id: "chat.summaryPanel.duration.hours" })}`);
  if (minutes > 0) {
    parts.push(`${minutes}${formatMessage({ id: "chat.summaryPanel.duration.minutes" })}`);
  }
  if (hours === 0 && (seconds > 0 || parts.length === 0)) {
    parts.push(`${seconds}${formatMessage({ id: "chat.summaryPanel.duration.seconds" })}`);
  }
  return parts.join(" ");
}

/** 工作卡与目录、标签页共用同一名称规则。 */
export const subagentWorkCardName = subagentDisplayName;

export interface SubagentWorkCardMemberInput {
  key: string;
  toolCallId: string;
  title: string;
  subagentType: string;
  childSessionId?: string;
  status: SubagentDisplayStatus;
  avatarIndex: number;
  fallbackName: string;
  model?: string;
  effort?: string;
  toolCallCount?: number;
  startedAt?: number;
  endedAt?: number;
  summaryText?: string;
}

export interface SubagentWorkCardMember {
  key: string;
  toolCallId: string;
  childSessionId?: string;
  /** 打开 tab 时传的可见标题（可能为空）。 */
  title: string;
  subagentType: string;
  name: string;
  /** 名称已是标题时为空，避免重复。 */
  taskSummary?: string;
  /** 失败 / 已停止的终态摘要。 */
  resultSummary?: string;
  status: SubagentDisplayStatus;
  avatarIndex: number;
  model?: string;
  effort?: string;
  toolCallCount?: number;
  startedAt?: number;
  endedAt?: number;
  stopWorkId?: string;
}

export interface SubagentWorkCardModel {
  members: SubagentWorkCardMember[];
  counts: SubagentStatusCounts;
  endedCount: number;
  active: boolean;
  startedAt?: number;
  endedAt?: number;
  /** "停止全部"的目标：每个可停的运行中成员一次（D7）。 */
  stopAllWorkIds: string[];
}

/**
 * 工作卡的纯派生：成员状态以 subagent 行为准，父会话 running[] 的 waiting / blocked 覆盖运行态；
 * 尚未登记子会话的运行中成员显示"等待启动"。停止只来自 live 索引里的可停 work。
 */
export function buildSubagentWorkCardModel(
  inputs: readonly SubagentWorkCardMemberInput[],
  liveIndex: SubagentWorkLiveIndex | undefined,
): SubagentWorkCardModel {
  const members = inputs.map((input): SubagentWorkCardMember => {
    const live = input.childSessionId ? liveIndex?.get(input.childSessionId) : undefined;
    const status: SubagentDisplayStatus = !input.childSessionId
      ? isSubagentStatusActive(input.status)
        ? "pending"
        : input.status
      : isSubagentStatusActive(input.status) && live?.liveStatus
        ? live.liveStatus
        : input.status;
    const name = subagentWorkCardName({
      title: input.title,
      subagentType: input.subagentType,
      fallbackName: input.fallbackName,
    });
    const title = input.title.trim();
    const summary = input.summaryText?.trim();
    const stopWorkId = resolveSubagentStopWorkId(live?.cancellableWorkId, status);
    return {
      key: input.key,
      toolCallId: input.toolCallId,
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      title: input.title,
      subagentType: input.subagentType,
      name,
      ...(title && title !== name ? { taskSummary: title } : {}),
      ...((status === "failed" || status === "cancelled") && summary && summary !== title
        ? { resultSummary: summary }
        : {}),
      status,
      avatarIndex: input.avatarIndex,
      ...(input.model ? { model: input.model } : {}),
      ...(input.model && input.effort ? { effort: input.effort } : {}),
      ...(input.toolCallCount !== undefined ? { toolCallCount: input.toolCallCount } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.endedAt !== undefined && !isSubagentStatusActive(status)
        ? { endedAt: input.endedAt }
        : {}),
      ...(stopWorkId ? { stopWorkId } : {}),
    };
  });
  const counts = summarizeSubagentStatuses(members.map((member) => member.status));
  const starts = members.flatMap((member) =>
    member.startedAt !== undefined ? [member.startedAt] : [],
  );
  const ends = members.flatMap((member) => (member.endedAt !== undefined ? [member.endedAt] : []));
  const active = counts.running > 0;
  return {
    members,
    counts,
    endedCount: members.length - counts.running,
    active,
    ...(starts.length > 0 ? { startedAt: Math.min(...starts) } : {}),
    ...(!active && ends.length > 0 ? { endedAt: Math.max(...ends) } : {}),
    stopAllWorkIds: members.flatMap((member) => (member.stopWorkId ? [member.stopWorkId] : [])),
  };
}
