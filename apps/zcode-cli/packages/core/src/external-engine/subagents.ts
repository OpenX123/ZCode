import { createHash } from "node:crypto";
import {
  createChildTraceContext,
  createMessageId,
  createSessionId,
  createTurnId,
  SessionEventType,
  type BackgroundTaskCancelResult,
  type ExternalEngineSubagentEvent,
  type ExternalEngineSubagentState,
  type InteractionRequestOrigin,
  type SessionId,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import { ExternalTranscriptWriter } from "./transcript-writer.js";

/**
 * 外部引擎原生子智能体的唯一 owner（父会话 Runtime 侧），规则见根仓
 * docs/desktop/external-agent-engines-spec.md「外部引擎原生子智能体」：
 * spawned → 子会话记录落库 → 父会话合成 Agent 行 + SubagentSpawned → 子正文 → state → 结束。
 * 幂等键为原生子 sessionId；YCode 子会话 ID 由（父会话 ID，原生 ID）确定性派生。
 */
const AGENT_TOOL_NAME = "Agent";
const DEFAULT_SUBAGENT_TYPE = "subagent";
const CHILD_SESSION_PREFIX = "ext-subagent_";
const CHILD_SESSION_HASH_LENGTH = 32;
const CHILD_INPUT_SOURCE = "subagent";
const CHILD_INPUT_PRESENTATION = "coordinator_input";
const CHILD_ERROR_NAME = "ExternalSubagentError";
const DIAGNOSTIC_EVENT_DROPPED = "session.external_engine.subagent.dropped";
const ENDED_ERROR_TEXT: Record<Exclude<EndState, "completed">, string> = {
  failed: "Subagent failed",
  cancelled: "Subagent cancelled",
  lost: "Subagent connection lost",
};

type EndState = Extract<ExternalEngineSubagentState, "completed" | "failed" | "cancelled" | "lost">;

interface ChildRun {
  index: number;
  /** 父会话（或直接父子会话）里承载 Agent 行的 writer。 */
  host: ExternalTranscriptWriter;
  hostCallId: string;
  promptPending: boolean;
  startedAt: number;
  writer?: ExternalTranscriptWriter;
  turnId?: TurnId;
  traceContext?: TraceContext;
  reply?: string;
}

interface ChildEntry {
  nativeSessionId: string;
  childSessionId: SessionId;
  parentNativeSessionId?: string;
  parentSessionId: SessionId;
  name: string;
  task?: string;
  prompt?: string;
  cancellable: boolean;
  runtime: AgentRuntimeInternal;
  runs: number;
  run?: ChildRun;
}

interface Registry {
  children: Map<string, ChildEntry>;
  turn?: TurnBinding;
}

interface TurnBinding {
  writer: ExternalTranscriptWriter;
  turnId: TurnId;
  traceContext: TraceContext;
}

const registries = new WeakMap<AgentRuntimeInternal, Registry>();

function registry(runtime: AgentRuntimeInternal): Registry {
  let value = registries.get(runtime);
  if (!value) {
    value = { children: new Map() };
    registries.set(runtime, value);
  }
  return value;
}

/** 确定性子会话 ID：同一父会话内同一原生 ID 永远映射到同一记录（回放、重启幂等）。 */
export function externalSubagentSessionId(
  parentSessionId: string,
  nativeSessionId: string,
): SessionId {
  const digest = createHash("sha256")
    .update(`${parentSessionId}\u0000${nativeSessionId}`)
    .digest("hex")
    .slice(0, CHILD_SESSION_HASH_LENGTH);
  return createSessionId(`${CHILD_SESSION_PREFIX}${digest}`);
}

function hostCallId(entry: ChildEntry, index: number): string {
  return `native-subagent:${entry.nativeSessionId}:${index}`;
}

function agentMetadata(entry: ChildEntry): Record<string, unknown> {
  return {
    childSessionId: entry.childSessionId,
    agentId: entry.nativeSessionId,
    agentType: DEFAULT_SUBAGENT_TYPE,
    description: entry.name,
    nativeSessionId: entry.nativeSessionId,
  };
}

export interface ExternalSubagentTurn {
  onSubagent(event: ExternalEngineSubagentEvent): Promise<void>;
  onChildUpdate(nativeSessionId: string, update: Record<string, unknown>): Promise<void>;
  /** 子会话权限请求的来源；未知子会话返回 undefined。 */
  origin(nativeSessionId: string): InteractionRequestOrigin | undefined;
  onDiagnostic(event: string, fields: Record<string, string>): void;
  /** 父轮收尾：仍在运行的子会话按 cancelled（停止）或 lost 收尾，正文保留。 */
  close(aborted: boolean): Promise<void>;
}

/** 把本轮父 writer 绑定为子智能体宿主；子会话注册表跨轮保留（RFD idle 子会话可再次委派）。 */
export function bindExternalSubagentTurn(
  runtime: AgentRuntimeInternal,
  binding: TurnBinding,
): ExternalSubagentTurn {
  const state = registry(runtime);
  state.turn = binding;
  const drop = (reason: string, nativeSessionId: string) =>
    runtime.logger?.debug("External engine subagent update dropped", {
      event: DIAGNOSTIC_EVENT_DROPPED,
      module: "core.external_engine",
      sessionId: runtime.sessionId,
      nativeSessionId,
      reason,
    });

  const emitOn = (
    writer: ExternalTranscriptWriter,
    type: Parameters<AgentRuntimeInternal["createEvent"]>[0],
    payload: Parameters<AgentRuntimeInternal["createEvent"]>[1],
  ) => writer.emit(type, payload);

  /** 子会话的一轮：TurnStarted + 首条 user 消息 + assistant writer，沿用普通外部轮的持久化。 */
  const beginChildTurn = async (entry: ChildEntry, text: string): Promise<ChildRun> => {
    const run = entry.run!;
    if (run.writer) return run;
    const child = entry.runtime;
    const turnId = createTurnId();
    const traceContext = createChildTraceContext(binding.traceContext, {
      turnId,
      sessionId: entry.childSessionId,
    });
    const userMessageId = createMessageId();
    await child.appendEvent(
      child.createEvent(
        SessionEventType.TurnStarted,
        {
          turnNumber: child.turnNumber,
          input: text,
          messageId: userMessageId,
          inputSource: CHILD_INPUT_SOURCE,
        },
        traceContext,
      ),
      traceContext,
    );
    await child.persistUserPrompt(userMessageId, text, undefined, traceContext, {
      inputPresentation: CHILD_INPUT_PRESENTATION,
    });
    const writer = new ExternalTranscriptWriter(child, userMessageId, traceContext);
    await writer.begin();
    Object.assign(run, { writer, turnId, traceContext, promptPending: false });
    return run;
  };

  const ensureChildTurn = (entry: ChildEntry): Promise<ChildRun> =>
    beginChildTurn(entry, entry.prompt ?? entry.task ?? entry.name);

  /** 一次运行：父 Agent 行 → SubagentSpawned →（可取消时）BackgroundTaskStarted。 */
  const startRun = async (
    entry: ChildEntry,
    host: ExternalTranscriptWriter,
    promptPending: boolean,
  ): Promise<void> => {
    entry.runs += 1;
    const callID = hostCallId(entry, entry.runs);
    entry.run = { index: entry.runs, host, hostCallId: callID, promptPending, startedAt: Date.now() };
    if (!promptPending) await ensureChildTurn(entry);
    const metadata = agentMetadata(entry);
    await host.startSyntheticTool({
      callID,
      tool: AGENT_TOOL_NAME,
      input: {
        description: entry.name,
        ...(entry.prompt ?? entry.task ? { prompt: entry.prompt ?? entry.task } : {}),
        subagent_type: DEFAULT_SUBAGENT_TYPE,
      },
      metadata,
    });
    await emitOn(host, SessionEventType.SubagentSpawned, {
      agentId: entry.nativeSessionId,
      agentType: DEFAULT_SUBAGENT_TYPE,
      childSessionId: entry.childSessionId,
      description: entry.name,
      ...(entry.prompt ?? entry.task ? { prompt: entry.prompt ?? entry.task } : {}),
      parentToolCallId: callID,
      status: "running",
    });
    if (entry.cancellable)
      await emitOn(host, SessionEventType.BackgroundTaskStarted, {
        taskId: entry.childSessionId,
        toolName: AGENT_TOOL_NAME,
        taskKind: "subagent",
        description: entry.name,
        status: "running",
        cancellable: true,
        childSessionId: entry.childSessionId,
      });
  };

  /** 运行宿主：主会话的本轮 writer，或直接父子会话的当前子轮 writer。 */
  const hostFor = async (entry: ChildEntry): Promise<ExternalTranscriptWriter | undefined> => {
    if (!entry.parentNativeSessionId) return binding.writer;
    const parent = state.children.get(entry.parentNativeSessionId);
    if (!parent?.run) return undefined;
    return (await ensureChildTurn(parent)).writer;
  };

  const endRun = async (entry: ChildEntry, end: EndState, error?: string): Promise<void> => {
    const run = entry.run;
    if (!run) return;
    // 子会话的后代先收尾，避免父子会话 writer 先关闭后再写 Agent 行终态。
    for (const other of [...state.children.values()].reverse())
      if (other.parentNativeSessionId === entry.nativeSessionId && other.run)
        await endRun(other, end === "completed" ? "lost" : end);
    const started = run.writer ? run : await ensureChildTurn(entry);
    entry.run = undefined;
    const writer = started.writer!;
    const traceContext = started.traceContext!;
    const errorText = end === "completed" ? undefined : (error ?? ENDED_ERROR_TEXT[end]);
    await writer.finish({
      aborted: end === "cancelled",
      ...(end === "failed" || end === "lost"
        ? { error: { name: CHILD_ERROR_NAME, data: { message: errorText } } }
        : {}),
    });
    const child = entry.runtime;
    const duration = Date.now() - run.startedAt;
    await child.appendEvent(
      end === "failed" || end === "lost"
        ? child.createEvent(
            SessionEventType.TurnError,
            {
              error: { type: CHILD_ERROR_NAME, message: errorText ?? ENDED_ERROR_TEXT.failed },
              turnPhase: "external_subagent",
            },
            traceContext,
          )
        : child.createEvent(
            SessionEventType.TurnComplete,
            {
              response: writer.response,
              tokenCount: 0,
              toolCallCount: writer.toolCallCount,
              duration,
              resultType: end === "cancelled" ? "cancelled" : "success",
            },
            traceContext,
          ),
      traceContext,
    );
    child.turnNumber += 1;
    const summary = run.reply ?? (writer.response.trim() || undefined);
    const metadata = agentMetadata(entry);
    await run.host.settleSyntheticTool(run.hostCallId, {
      success: end === "completed",
      output:
        end === "completed"
          ? JSON.stringify({
              ...metadata,
              status: end,
              ...(summary ? { result: summary } : {}),
            })
          : errorText!,
      metadata,
    });
    await emitOn(run.host, SessionEventType.SubagentStopped, {
      agentId: entry.nativeSessionId,
      agentType: DEFAULT_SUBAGENT_TYPE,
      childSessionId: entry.childSessionId,
      parentToolCallId: run.hostCallId,
      status: end,
      ...(summary || errorText ? { summaryText: summary ?? errorText } : {}),
    });
    if (entry.cancellable)
      await emitOn(run.host, SessionEventType.BackgroundTaskCompleted, {
        taskId: entry.childSessionId,
        toolName: AGENT_TOOL_NAME,
        taskKind: "subagent",
        status: end,
        cancellable: false,
        childSessionId: entry.childSessionId,
      });
  };

  const spawned = async (
    event: Extract<ExternalEngineSubagentEvent, { type: "spawned" }>,
  ): Promise<void> => {
    const existing = state.children.get(event.nativeSessionId);
    if (existing) {
      // 同一原生 ID 的重复宣告（含回放）不建第二份记录；已结束时视为再次运行。
      if (!existing.run) await reopen(existing, Boolean(event.promptPending));
      return;
    }
    const parent = event.parentNativeSessionId
      ? state.children.get(event.parentNativeSessionId)
      : undefined;
    if (event.parentNativeSessionId && !parent) return drop("unknown_parent", event.nativeSessionId);
    const childSessionId = externalSubagentSessionId(runtime.sessionId, event.nativeSessionId);
    const parentSessionId = parent?.childSessionId ?? runtime.sessionId;
    const child = runtime.createExternalSubagentRuntime({
      childSessionId,
      parentSessionId,
      traceContext: binding.traceContext,
    });
    const entry: ChildEntry = {
      nativeSessionId: event.nativeSessionId,
      childSessionId,
      ...(event.parentNativeSessionId ? { parentNativeSessionId: event.parentNativeSessionId } : {}),
      parentSessionId,
      name: event.name,
      ...(event.task ? { task: event.task } : {}),
      ...(event.prompt ? { prompt: event.prompt } : {}),
      cancellable: event.cancellable,
      runtime: child,
      runs: 0,
    };
    // 记录必须先于 SubagentSpawned 落库；重启后同 ID 再现时恢复既有记录后续写。
    if (await runtime.sessionStore?.getSession(childSessionId))
      await child.resumeFromStore({ traceContext: binding.traceContext });
    else await child.ensureSessionPersisted(event.name, binding.traceContext);
    state.children.set(event.nativeSessionId, entry);
    const host = await hostFor(entry);
    if (!host) return drop("parent_not_running", event.nativeSessionId);
    await startRun(entry, host, Boolean(event.promptPending) && !event.prompt);
  };

  const reopen = async (entry: ChildEntry, promptPending: boolean): Promise<void> => {
    const host = await hostFor(entry);
    if (!host) return drop("parent_not_running", entry.nativeSessionId);
    entry.prompt = undefined;
    await startRun(entry, host, promptPending);
  };

  return {
    async onSubagent(event) {
      if (event.type === "spawned") return spawned(event);
      const entry = state.children.get(event.nativeSessionId);
      if (!entry) return drop(`unknown_${event.type}`, event.nativeSessionId);
      if (event.type === "prompt") {
        if (!entry.run) await reopen(entry, true);
        const run = entry.run;
        if (!run || run.writer) return;
        entry.prompt = event.text;
        await beginChildTurn(entry, event.text);
        return;
      }
      if (event.type === "reply") {
        if (entry.run) entry.run.reply = event.text;
        return;
      }
      if (event.state === "running" || event.state === "waiting") {
        // RFD idle 子会话再次 running：同一记录开启新的子轮；waiting 由权限 origin 投影。
        if (!entry.run && event.state === "running") await reopen(entry, true);
        return;
      }
      if (entry.run) await endRun(entry, event.state, event.error);
    },
    async onChildUpdate(nativeSessionId, update) {
      const entry = state.children.get(nativeSessionId);
      if (!entry?.run) return drop("child_not_running", nativeSessionId);
      const run = await ensureChildTurn(entry);
      if (await run.writer!.apply(update)) return;
      if (
        update.sessionUpdate === "usage_update" &&
        typeof update.used === "number" &&
        typeof update.size === "number"
      )
        await run.writer!.emit(SessionEventType.ExternalEngineUsageUpdated, {
          used: update.used,
          size: update.size,
        });
    },
    origin(nativeSessionId) {
      const entry = state.children.get(nativeSessionId);
      if (!entry) return undefined;
      return {
        kind: "subagent",
        agentId: entry.nativeSessionId,
        agentType: DEFAULT_SUBAGENT_TYPE,
        childSessionId: entry.childSessionId,
        description: entry.name,
        parentSessionId: entry.parentSessionId,
        ...(entry.run ? { parentToolCallId: entry.run.hostCallId } : {}),
        ...(entry.run?.turnId ? { childTurnId: entry.run.turnId } : {}),
        parentTurnId: binding.turnId,
      };
    },
    onDiagnostic(event, fields) {
      runtime.logger?.debug("External engine subagent diagnostic", {
        event,
        module: "core.external_engine",
        sessionId: runtime.sessionId,
        ...fields,
      });
    },
    async close(aborted) {
      // 子会话生命周期绑定父轮：父轮结束后 YCode 不再观察原生子会话。
      for (const entry of [...state.children.values()].reverse())
        if (entry.run && !entry.parentNativeSessionId)
          await endRun(entry, aborted ? "cancelled" : "lost");
      for (const entry of [...state.children.values()].reverse())
        if (entry.run) await endRun(entry, aborted ? "cancelled" : "lost");
      if (state.turn === binding) state.turn = undefined;
    },
  };
}

/** Stop 入口：workId ≡ childSessionId；只处理原生声明可取消的运行中子会话。 */
export async function cancelExternalSubagentWork(
  runtime: AgentRuntimeInternal,
  workId: string,
): Promise<BackgroundTaskCancelResult | undefined> {
  const entry = [...(registries.get(runtime)?.children.values() ?? [])].find(
    (item) => item.childSessionId === workId,
  );
  if (!entry) return undefined;
  if (!entry.run || !entry.cancellable || !runtime.externalEnginePort?.cancelSubagent)
    return {
      cancelled: false,
      reason: entry.run ? "background_task_not_cancellable" : "background_task_not_running",
      status: entry.run ? "running" : "completed",
      taskId: workId,
    };
  await runtime.externalEnginePort.cancelSubagent(runtime.sessionId, entry.nativeSessionId);
  // 真实结束以原生后续 state 为准；这里只表示已投递停止请求。
  return { cancelled: true, status: "running", taskId: workId };
}

