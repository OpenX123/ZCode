import {
  LOCAL_TTFT_CLOCK_TTL_MS,
  LOCAL_TTFT_MAX_DETAILS,
  type LocalTtftContext,
  type LocalTtftCalibration,
  type LocalTtftFacts,
  type LocalTtftRecord,
  type LocalTtftOutputKind,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
export interface LocalTtftPending {
  context: LocalTtftContext;
  workspace: string;
  start: number;
  wallStart: number;
  clockInvalid?: boolean;
  closed?: boolean;
  outcome?: LocalTtftRecord["outcome"];
  textClosed?: boolean;
  firstAt?: number;
  checkpointRevision: number;
  checkpointSignature?: string;
  dispatch?: number;
  commandId?: string;
  sessionId?: string;
  facts?: LocalTtftFacts;
  first?: LocalTtftOutputKind;
  lastSeq: number;
  sendMode: "idle" | "queued" | "guided";
  visibility: "foreground" | "background" | "background_returned";
  visibilityChanges: { at: number; foreground: boolean }[];
  confirmationStart?: number;
  rendererDetails: NonNullable<LocalTtftRecord["details"]>;
  rows: Map<number, { turnId: string; kind: ConversationRow["kind"] }>;
  /** dispatch 时的会话引擎；只用于本地性能摘要。 */
  engine?: string;
  /** Renderer 收到 accepted/duplicate ACK 的时刻（Renderer 时钟）。 */
  ackAt?: number;
  /** 本观测是否已输出本地性能摘要（每次观测至多一条）。 */
  summarized?: boolean;
}

/**
 * 1.1 本地性能摘要：生产包落盘的一行 info，只含数字、布尔、枚举与生成的标识。
 * 用 type 而非 interface，保证可直接作为平台日志的字段记录传递。
 */
export type LocalPerfSummary = {
  version: 1;
  observationId: string;
  commandId: string | null;
  sessionId: string | null;
  outcome: LocalTtftRecord["outcome"];
  engine: "zcode" | "claude-code" | "codex" | "unknown";
  start: "cold" | "warm";
  sendMode: "idle" | "queued" | "guided";
  quality: LocalTtftRecord["quality"];
  clickToPreviewMs: number | null;
  clickToAckMs: number | null;
  clickToReceivedMs: number | null;
  clickToAdmittedMs: number | null;
  enginePrepareMs: number | null;
  requestToFirstContentMs: number | null;
  totalMs: number;
};

const SUMMARY_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/u;
const SUMMARY_ENGINES = new Set(["zcode", "claude-code", "codex"]);

function summaryIdentifier(value: string | undefined): string | null {
  // 摘要不得携带路径、正文或其他自由文本；只放行生成的标识字符集。
  return value !== undefined && SUMMARY_IDENTIFIER.test(value) ? value : null;
}

function summaryDuration(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined || !Number.isFinite(end - start) || end < start)
    return null;
  return Math.round(end - start);
}

/** 由闭合记录派生摘要；跨进程阶段只在记录已校准（aligned）时给出。 */
export function buildLocalPerfSummary(
  pending: LocalTtftPending,
  record: LocalTtftRecord,
  start: LocalPerfSummary["start"],
): LocalPerfSummary {
  const detail = (stage: string) =>
    record.details?.find((item) => item.stage === stage && item.end !== undefined);
  const interval = (stage: LocalTtftRecord["intervals"][number]["stage"]) =>
    record.intervals.find((item) => item.stage === stage);
  const preview = detail("optimistic_render");
  const received = detail("command_received");
  const admission = interval("command_admission");
  const enginePrepare = detail("engine_prepare");
  const modelRequest = interval("model_request");
  return {
    version: 1,
    observationId: summaryIdentifier(record.observationId) ?? "invalid",
    commandId: summaryIdentifier(record.commandId ?? pending.commandId),
    sessionId: summaryIdentifier(record.sessionId ?? pending.sessionId),
    outcome: record.outcome,
    engine:
      pending.engine && SUMMARY_ENGINES.has(pending.engine)
        ? (pending.engine as LocalPerfSummary["engine"])
        : "unknown",
    start,
    sendMode: record.sendMode ?? pending.sendMode,
    quality: record.quality,
    clickToPreviewMs: summaryDuration(pending.start, preview?.end),
    clickToAckMs: summaryDuration(pending.start, pending.ackAt),
    clickToReceivedMs: summaryDuration(pending.start, received?.end),
    clickToAdmittedMs: summaryDuration(pending.start, admission?.end),
    enginePrepareMs: summaryDuration(enginePrepare?.start, enginePrepare?.end),
    requestToFirstContentMs: summaryDuration(modelRequest?.start, modelRequest?.end),
    totalMs: summaryDuration(record.start, record.end) ?? 0,
  };
}

export function buildLocalTtftRecord(
  pending: LocalTtftPending,
  kind: LocalTtftRecord["kind"],
  outcome: LocalTtftRecord["outcome"],
  current: number,
  wall: number,
  calibration?: LocalTtftCalibration,
): LocalTtftRecord {
  pending.clockInvalid ||= Math.abs(wall - pending.wallStart - (current - pending.start)) > 100;
  const end = kind === "checkpoint" && pending.firstAt !== undefined ? pending.firstAt : current;
  const facts = pending.facts;
  const aligned =
    calibration &&
    facts?.instanceId === calibration.instanceId &&
    end >= calibration.measuredAt &&
    end - calibration.measuredAt <= LOCAL_TTFT_CLOCK_TTL_MS &&
    !pending.clockInvalid &&
    !facts.clockInvalid;
  const offset = aligned ? calibration.offsetMs : 0;
  const intervals: LocalTtftRecord["intervals"] = [];
  let invalid = pending.clockInvalid === true || facts?.clockInvalid === true;
  const interval = (
    stage: LocalTtftRecord["intervals"][number]["stage"],
    start: number | undefined,
    stop: number | undefined,
    source: "renderer" | "cli" | "aligned",
  ) => {
    if (start === undefined || stop === undefined) return;
    if (stop < start || !Number.isFinite(stop - start)) {
      invalid = true;
      return;
    }
    intervals.push({ stage, start, end: stop, source });
  };
  interval("renderer_prepare", pending.start, pending.dispatch, "renderer");
  if (facts) {
    const at = (value: number | undefined) => (value === undefined ? undefined : value + offset);
    if (aligned) interval("command_admission", pending.dispatch, at(facts.admittedAt), "aligned");
    interval("execution_wait", at(facts.admittedAt), at(facts.executionAt), "cli");
    interval("request_prepare", at(facts.executionAt), at(facts.requestAt), "cli");
    interval("model_request", at(facts.requestAt), at(facts.outputAt), "cli");
    if (aligned && pending.firstAt !== undefined)
      interval("output_return", at(facts.outputAt), pending.firstAt, "aligned");
  }
  const commandDetails: NonNullable<LocalTtftRecord["details"]> = [];
  if (facts) {
    if (aligned && pending.dispatch !== undefined && facts.receivedAt + offset >= pending.dispatch)
      commandDetails.push({
        id: "command:received",
        stage: "command_received",
        start: pending.dispatch,
        end: facts.receivedAt + offset,
        source: "renderer",
        outcome: "completed",
      });
    if (facts.admittedAt !== undefined && facts.admittedAt >= facts.receivedAt)
      commandDetails.push({
        id: "command:admitted",
        stage: "command_admitted",
        start: facts.receivedAt + offset,
        end: facts.admittedAt + offset,
        source: "cli",
        outcome: "completed",
      });
  }
  return {
    version: 1,
    observationId: pending.context.observationId,
    commandId: pending.commandId,
    sessionId: facts?.sessionId,
    turnId: facts?.turnId,
    productTurnId: facts?.productTurnId,
    queryId: facts?.queryId,
    logicalCallId: facts?.logicalCallId,
    cliVersion: facts?.cliVersion,
    requestId: facts?.requestId,
    cliInstanceId: facts?.instanceId,
    kind,
    ...(kind === "checkpoint"
      ? { checkpointId: `checkpoint:${pending.checkpointRevision++}` }
      : {}),
    outcome,
    start: pending.start,
    end,
    firstOutputKind: pending.first,
    sendMode: facts?.sendMode ?? pending.sendMode,
    visibility: pending.visibility,
    visibilityChanges: [...pending.visibilityChanges],
    userWaitMs: pending.rendererDetails
      .filter((detail) => detail.stage === "user_confirmation")
      .reduce((sum, detail) => sum + (detail.end! - detail.start), 0),
    details: [
      ...pending.rendererDetails,
      ...commandDetails,
      ...(facts?.details ?? []).map((detail) => ({
        ...detail,
        start: detail.start + offset,
        ...(detail.end === undefined ? {} : { end: detail.end + offset }),
      })),
    ].slice(0, LOCAL_TTFT_MAX_DETAILS),
    truncated:
      facts?.truncated ||
      (facts?.details?.length ?? 0) + pending.rendererDetails.length + commandDetails.length >
        LOCAL_TTFT_MAX_DETAILS,
    timingReliable: !pending.clockInvalid,
    cliTimingReliable: facts?.clockInvalid !== true,
    ...(aligned && facts?.executionAt !== undefined && end >= facts.executionAt + offset
      ? { executionMs: end - facts.executionAt - offset }
      : {}),
    // Bug 原因：此前只要未对齐就标 clock_invalid，把“校准缺失/过期”与真实时钟异常混为一类，
    // 可靠的排队样本被默认看板当作坏时钟过滤。未对齐只意味着跨进程阶段缺失，按 missing 记。
    quality: invalid ? "clock_invalid" : intervals.length === 6 ? "complete" : "missing",
    ...(calibration ? { clockErrorMs: calibration.errorMs } : {}),
    intervals,
    model: facts?.model,
    provider: facts?.provider,
  };
}
