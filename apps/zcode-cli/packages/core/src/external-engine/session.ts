import { persistGeneratedSessionTitle } from "../runtime/methods/session-title.js";
import {
  engineConfigOptionSchema,
  isExternalSessionEngine,
  readExternalEngineFailure,
} from "@zcode/shared";
import { planStateSchema, type PlanState } from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  ExternalEngineConnectionError,
  type ExternalEngineSessionInput,
  type SessionEvent,
  type TraceContext,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import type { EngineConfigOption } from "@zcode/shared";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const plans = new WeakMap<AgentRuntimeInternal, PlanState>();
const retries = new WeakMap<AgentRuntimeInternal, number>();
const handoffs = new WeakMap<AgentRuntimeInternal, SessionEntryInfo | null>();

function restoreHandoff(
  runtime: AgentRuntimeInternal,
  entries: SessionEntryInfo[] | undefined,
): void {
  const entry = entries?.findLast((item) => item.type === "external_engine_handoff");
  const data = record(entry?.data);
  handoffs.set(
    runtime,
    entry &&
      typeof data.context === "string" &&
      data.context.trim() &&
      typeof data.consumedAt !== "number"
      ? entry
      : null,
  );
}

export async function readExternalEngineHandoff(
  runtime: AgentRuntimeInternal,
): Promise<string | undefined> {
  if (!handoffs.has(runtime))
    restoreHandoff(
      runtime,
      await runtime.sessionStore?.sessionEntries?.({ sessionID: runtime.sessionId }),
    );
  const context = record(handoffs.get(runtime)?.data).context;
  return typeof context === "string" ? context : undefined;
}

export async function completeExternalEngineHandoff(runtime: AgentRuntimeInternal): Promise<void> {
  const entry = handoffs.get(runtime);
  if (!entry || !runtime.config.externalSessionId) return;
  const now = Date.now();
  await runtime.sessionStore?.saveSessionEntry?.({
    ...entry,
    touchSession: false,
    time: { ...entry.time, updated: now },
    data: {
      ...record(entry.data),
      consumedAt: now,
      nativeSessionId: runtime.config.externalSessionId,
    },
  });
  handoffs.set(runtime, null);
}

async function publishPlan(
  runtime: AgentRuntimeInternal,
  plan: PlanState,
  traceContext: TraceContext,
  events?: SessionEvent[],
): Promise<void> {
  plans.set(runtime, plan);
  await persistExternalPlan(runtime);
  const event = runtime.createEvent(
    SessionEventType.ExternalEnginePlanUpdated,
    { plan },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events?.push(event);
}

/** 真实进度和终态结束活动重试，清单 pending 不参与运行态判定。 */
export async function clearExternalEngineRetry(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  events?: SessionEvent[],
): Promise<void> {
  if (!retries.has(runtime)) return;
  retries.delete(runtime);
  const event = runtime.createEvent(
    SessionEventType.ExternalEngineFailureUpdated,
    { failure: null },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events?.push(event);
}

function planItems(entries: unknown): PlanState["items"] {
  if (!Array.isArray(entries)) throw new Error("Invalid ACP plan entries");
  return entries
    .map((value, index) => {
      const item = record(value);
      return {
        id: typeof item.id === "string" ? item.id : `external-plan-${index}`,
        content: item.content,
        status: item.status === "in_progress" ? "inProgress" : item.status,
      };
    })
    .map((item) => planStateSchema.shape.items.element.parse(item));
}
export async function publishExternalEngineSessionUpdate(
  runtime: AgentRuntimeInternal,
  update: Record<string, unknown>,
  traceContext: TraceContext,
  events?: SessionEvent[],
): Promise<void> {
  const emit = async (
    type: Parameters<AgentRuntimeInternal["createEvent"]>[0],
    payload: Parameters<AgentRuntimeInternal["createEvent"]>[1],
  ) => {
    const event = runtime.createEvent(type, payload, traceContext);
    await runtime.appendEvent(event, traceContext);
    events?.push(event);
  };
  const kind = update.sessionUpdate;
  const nativeError = record(record(record(update._meta).codex).error);
  if (kind === "session_info_update" && typeof nativeError.message === "string") {
    const attempt = (retries.get(runtime) ?? 0) + 1;
    if (nativeError.willRetry === true) retries.set(runtime, attempt);
    else retries.delete(runtime);
    await emit(SessionEventType.ExternalEngineFailureUpdated, {
      failure: readExternalEngineFailure(nativeError),
      retrying: nativeError.willRetry === true,
      attempt,
    });
  }
  if (kind === "plan" || kind === "plan_update" || kind === "plan_removed") {
    const previous = plans.get(runtime) ?? { items: [], updatedAt: Date.now() };
    let plan = { ...previous, updatedAt: Date.now() };
    if (kind === "plan") plan.items = planItems(update.entries);
    else if (kind === "plan_update") {
      const document = record(update.plan);
      if (
        document.type === "markdown" &&
        typeof document.planId === "string" &&
        typeof document.content === "string"
      )
        plan.document = { id: document.planId, markdown: document.content };
      else if (document.type === "items") plan.items = planItems(document.items);
      // 不读取外部引擎提供的任意 file URI；仅消费结构化内容。
      else return;
    } else if (previous.document?.id === update.planId) delete plan.document;
    else return;
    await clearExternalEngineRetry(runtime, traceContext, events);
    await publishPlan(runtime, planStateSchema.parse(plan), traceContext, events);
    return;
  }
  if (kind === "session_info_update" && typeof update.title === "string") {
    await persistGeneratedSessionTitle.call(runtime, {
      messageID: undefined,
      title: update.title,
      traceContext: traceContext,
    });
  } else if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
    const commands = update.availableCommands.map((value) => {
      const command = record(value);
      if (typeof command.name !== "string" || typeof command.description !== "string")
        throw new Error("Invalid ACP command");
      const hint = record(command.input).hint;
      return {
        name: command.name,
        description: command.description,
        ...(typeof hint === "string" ? { input: { hint } } : {}),
      };
    });
    await emit(SessionEventType.ExternalEngineCommandsUpdated, { commands });
  } else if (
    kind === "usage_update" &&
    typeof update.used === "number" &&
    typeof update.size === "number"
  ) {
    await emit(SessionEventType.ExternalEngineUsageUpdated, {
      used: update.used,
      size: update.size,
    });
  }
}

export function externalEngineSessionInput(
  runtime: AgentRuntimeInternal,
  signal: AbortSignal,
  traceContext: TraceContext,
): ExternalEngineSessionInput {
  const engine = runtime.config.engine;
  if (!isExternalSessionEngine(engine) || !runtime.externalEnginePort)
    throw Object.assign(new Error("External engine is not ready"), { code: "engine_not_ready" });
  if (runtime.isRemoteWorkspace())
    throw new Error("External engines currently require a local workspace");
  return {
    sessionId: runtime.sessionId,
    engine,
    externalSessionId: runtime.config.externalSessionId,
    connectionProfileId: runtime.engineConnectionProfileId,
    async onConnectionProfile(id) {
      runtime.engineConnectionProfileId = id;
      await persistExternalEngineConfig(runtime);
    },
    configValues: runtime.engineConfigOptions.map(({ id, currentValue }) => ({
      id,
      value: currentValue,
    })),
    cwd: runtime.workingDirectory,
    signal,
    traceContext,
    async onSession(id) {
      runtime.config.externalSessionId = id;
      // 预热草稿尚未入库；首发提升会连同 externalSessionId 一起持久化。
      if (runtime.sessionPersisted)
        await runtime.sessionStore?.updateSession({ id: runtime.sessionId, externalSessionId: id });
    },
    onConfigOptions: (options) => publishExternalEngineConfig(runtime, options, traceContext),
    onUpdate: (update) => publishExternalEngineSessionUpdate(runtime, update, traceContext),
    // 初始化尚无 turn，不能授予任何工具执行权限。
    requestPermission: async () => ({ outcome: "cancelled" }),
  };
}
export async function prepareExternalEngineSession(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (runtime.shuttingDown) return;
  await publishExternalEngineConfigState(runtime, "connecting", traceContext);
  if (runtime.shuttingDown) return;
  try {
    const input = externalEngineSessionInput(runtime, new AbortController().signal, traceContext);
    await runtime.externalEnginePort!.prepareSession(input);
    if (!runtime.shuttingDown)
      await publishExternalEngineConfigState(runtime, "ready", traceContext);
  } catch (error) {
    if (!runtime.shuttingDown) await publishExternalEngineConfigError(runtime, error, traceContext);
    throw error;
  }
}

export async function publishExternalEngineConfigError(
  runtime: AgentRuntimeInternal,
  error: unknown,
  traceContext: TraceContext,
): Promise<void> {
  const failure =
    error instanceof ExternalEngineConnectionError ? error.failure : { code: "request" as const };
  await publishExternalEngineConfigState(runtime, "error", traceContext, failure);
  runtime.logger?.warn("External engine connection failed", {
    event: "session.external_engine.connection_failed",
    module: "core.external_engine",
    sessionId: runtime.sessionId,
    ...failure,
  });
}

export async function publishExternalEngineConfig(
  runtime: AgentRuntimeInternal,
  options: EngineConfigOption[],
  traceContext: TraceContext,
): Promise<void> {
  await persistExternalEngineConfig(runtime, options);
  runtime.engineConfigOptions = structuredClone(options);
  await publishExternalEngineConfigState(
    runtime,
    runtime.engineConfigState === "connecting" ? "connecting" : "ready",
    traceContext,
  );
}

async function publishExternalEngineConfigState(
  runtime: AgentRuntimeInternal,
  state: import("@zcode/shared").EngineConfigState,
  traceContext: TraceContext,
  failure?: import("@zcode/shared").EngineConnectionFailure,
): Promise<void> {
  runtime.engineConfigState = state;
  runtime.engineConfigError = failure;
  const event = runtime.createEvent(
    SessionEventType.ExternalEngineConfigUpdated,
    {
      engine: runtime.config.engine ?? "zcode",
      engineConfigOptions: runtime.engineConfigOptions,
      engineConfigState: state,
      engineConfigError: failure,
    },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
}

const CONFIG_ENTRY_TYPE = "external_engine_config";
const PLAN_ENTRY_TYPE = "external_engine_plan";

async function persistExternalPlan(runtime: AgentRuntimeInternal): Promise<void> {
  const plan = plans.get(runtime);
  if (!plan || !runtime.sessionPersisted) return;
  const now = Date.now();
  await runtime.sessionStore?.saveSessionEntry?.({
    id: `${runtime.sessionId}:external-engine-plan`,
    sessionID: runtime.sessionId,
    type: PLAN_ENTRY_TYPE,
    touchSession: false,
    time: { created: now, updated: now },
    data: plan,
  });
}

export async function persistExternalEngineConfig(
  runtime: AgentRuntimeInternal,
  options = runtime.engineConfigOptions,
): Promise<void> {
  if (!runtime.sessionPersisted || !isExternalSessionEngine(runtime.config.engine)) return;
  const now = Date.now();
  await runtime.sessionStore?.saveSessionEntry?.({
    id: `${runtime.sessionId}:external-engine-config`,
    sessionID: runtime.sessionId,
    type: CONFIG_ENTRY_TYPE,
    touchSession: false,
    time: { created: now, updated: now },
    data: {
      engine: runtime.config.engine,
      engineConfigOptions: options,
      connectionProfileId: runtime.engineConnectionProfileId,
    },
  });
  await persistExternalPlan(runtime);
}

export async function restoreExternalEngineConfig(
  runtime: AgentRuntimeInternal,
  traceContext?: TraceContext,
): Promise<void> {
  const entries = await runtime.sessionStore?.sessionEntries?.({ sessionID: runtime.sessionId });
  restoreHandoff(runtime, entries);
  const saved = record(entries?.findLast((entry) => entry.type === CONFIG_ENTRY_TYPE)?.data);
  if (saved.engine === runtime.config.engine) {
    runtime.engineConnectionProfileId =
      typeof saved.connectionProfileId === "string" ? saved.connectionProfileId : undefined;
    // 只恢复已确认值；实际可选目录和就绪状态仍由原生 resume 决定。
    runtime.engineConfigOptions = engineConfigOptionSchema.array().parse(saved.engineConfigOptions);
  }
  const plan = planStateSchema.safeParse(
    entries?.findLast((entry) => entry.type === PLAN_ENTRY_TYPE)?.data,
  );
  if (plan.success) {
    plans.set(runtime, plan.data);
    if (traceContext) await publishPlan(runtime, plan.data, traceContext);
  }
}
