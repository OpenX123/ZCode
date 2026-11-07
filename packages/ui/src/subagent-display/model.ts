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
  return title?.trim() || subagentType?.trim() || fallbackName;
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
  const control = buildSubagentControlWorkIndex(parent?.backgroundWorks).get(childSessionId);
  const stopWorkId =
    control && control.cancellable !== false && isSubagentStatusActive(status)
      ? control.workId
      : undefined;
  return {
    avatarIndex,
    variant: resolveSubagentFaceVariant(running?.subagentType ?? subagentType),
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(stopWorkId ? { stopWorkId } : {}),
  };
}
