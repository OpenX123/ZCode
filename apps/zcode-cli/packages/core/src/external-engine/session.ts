import { persistGeneratedSessionTitle } from "../runtime/methods/session-title.js";
import { engineConfigOptionSchema, isExternalSessionEngine } from "@zcode/shared";
import { planStateSchema, type PlanState } from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  ExternalEngineConnectionError,
  type ExternalEngineFailureNotice,
  type ExternalEngineSessionInput,
  type SessionEvent,
  type TraceContext,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import type { EngineConfigOption, EngineConnectionFailure } from "@zcode/shared";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const plans = new WeakMap<AgentRuntimeInternal, PlanState>();
const handoffs = new WeakMap<AgentRuntimeInternal, SessionEntryInfo | null>();

/**
 * 结构化失败的幂等状态（每个 Runtime 一份）：失败 ID → 最新 revision，已终态的 ID 不再接受重试。
 * 迟到的 adapter 重试可能落在下一轮的 trace 上，投影的 turnId 隔离拦不住，必须在 owner 侧按 ID 丢弃。
 */
interface ExternalEngineFailureState {
  active: boolean;
  retryCount: number;
  revisions: Map<string, number>;
  terminalIds: string[];
}
const MAX_TERMINAL_FAILURE_IDS = 32;
const failureStates = new WeakMap<AgentRuntimeInternal, ExternalEngineFailureState>();
function failureState(runtime: AgentRuntimeInternal): ExternalEngineFailureState {
  let state = failureStates.get(runtime);
  if (!state) {
    state = { active: false, retryCount: 0, revisions: new Map(), terminalIds: [] };
    failureStates.set(runtime, state);
  }
  return state;
}

/** 计划审批与“无审批开始执行”的本轮事实；只服务 Runtime 自身判定，不进入投影。 */
interface ExternalEnginePlanTurn {
  documentUpdated: boolean;
  reviewRequested: boolean;
}
const planTurns = new WeakMap<AgentRuntimeInternal, ExternalEnginePlanTurn>();
/** 模式配置（含 plan 值的选项）最近一次非 Plan 值；随 external_engine_config entry 持久化。 */
const planExitValues = new WeakMap<AgentRuntimeInternal, Record<string, string>>();
export const NATIVE_PLAN_MODE_VALUE = "plan";
const DEFAULT_PLAN_EXIT_VALUE = "default";

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

/** 含 plan 值的原生模式选项（Claude `mode`、Codex `collaboration_mode`）。 */
export function nativePlanModeOption(
  runtime: AgentRuntimeInternal,
): EngineConfigOption | undefined {
  return runtime.engineConfigOptions.find((option) =>
    option.options.some((item) => item.value === NATIVE_PLAN_MODE_VALUE),
  );
}

/** 进入计划前的模式值；未知时取 default（两家引擎的保守非 Plan 值）。 */
export function externalEnginePlanExitValue(
  runtime: AgentRuntimeInternal,
  option: EngineConfigOption,
): string | undefined {
  const remembered = planExitValues.get(runtime)?.[option.id];
  const candidates = [remembered, DEFAULT_PLAN_EXIT_VALUE];
  return candidates.find(
    (value) =>
      value !== undefined &&
      value !== NATIVE_PLAN_MODE_VALUE &&
      option.options.some((item) => item.value === value),
  );
}

function rememberPlanExitValues(runtime: AgentRuntimeInternal, options: EngineConfigOption[]) {
  for (const option of options) {
    if (!option.options.some((item) => item.value === NATIVE_PLAN_MODE_VALUE)) continue;
    if (option.currentValue === NATIVE_PLAN_MODE_VALUE) continue;
    planExitValues.set(runtime, {
      ...planExitValues.get(runtime),
      [option.id]: option.currentValue,
    });
  }
}

/** 新一轮开始：重置本轮计划事实，并收回上一轮发布的“无审批开始执行”入口。 */
export async function beginExternalEnginePlanTurn(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  events?: SessionEvent[],
): Promise<void> {
  planTurns.set(runtime, { documentUpdated: false, reviewRequested: false });
  const plan = plans.get(runtime);
  if (!plan?.startWithoutReview) return;
  const next = { ...plan, updatedAt: Date.now() };
  delete next.startWithoutReview;
  await publishPlan(runtime, planStateSchema.parse(next), traceContext, events);
}

export function markExternalEnginePlanReviewRequested(runtime: AgentRuntimeInternal): void {
  const turn = planTurns.get(runtime);
  if (turn) turn.reviewRequested = true;
}

/**
 * 成功轮收尾：本轮写出计划文档、未发审批请求且原生模式仍为 Plan 时，发布切出 Plan 的配置值，
 * 供计划卡“开始执行”先切模式再发送可见消息（docs/desktop/native-plan-errors-spec.md）。
 */
export async function finishExternalEnginePlanTurn(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  events?: SessionEvent[],
): Promise<void> {
  const turn = planTurns.get(runtime);
  planTurns.delete(runtime);
  const plan = plans.get(runtime);
  const option = nativePlanModeOption(runtime);
  if (!turn?.documentUpdated || turn.reviewRequested || !plan?.document || !option) return;
  if (option.currentValue !== NATIVE_PLAN_MODE_VALUE) return;
  const value = externalEnginePlanExitValue(runtime, option);
  if (!value) return;
  await publishPlan(
    runtime,
    planStateSchema.parse({
      ...plan,
      updatedAt: Date.now(),
      startWithoutReview: { configId: option.id, value },
    }),
    traceContext,
    events,
  );
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
  const state = failureStates.get(runtime);
  if (!state?.active) return;
  state.active = false;
  state.retryCount = 0;
  const event = runtime.createEvent(
    SessionEventType.ExternalEngineFailureUpdated,
    { failure: null },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events?.push(event);
}

/** 已收口的终态失败 ID；之后同 ID 的重试一律丢弃。 */
export function markExternalEngineFailureTerminal(
  runtime: AgentRuntimeInternal,
  failure: EngineConnectionFailure,
): void {
  if (!failure.failureId) return;
  const state = failureState(runtime);
  if (state.terminalIds.includes(failure.failureId)) return;
  state.terminalIds.push(failure.failureId);
  if (state.terminalIds.length > MAX_TERMINAL_FAILURE_IDS) state.terminalIds.shift();
}

/**
 * adapter 已归一脱敏的失败通知：warning 发布活动重试，error 只登记终态并收口重试——
 * 本轮的终态失败由 prompt 结果或 RPC 错误经既有 turn 失败路径结束（见 turn.ts）。
 */
export async function publishExternalEngineFailureNotice(
  runtime: AgentRuntimeInternal,
  notice: ExternalEngineFailureNotice,
  traceContext: TraceContext,
  events?: SessionEvent[],
): Promise<void> {
  const state = failureState(runtime);
  const id = notice.failure.failureId;
  if (id) {
    if (state.terminalIds.includes(id)) return;
    const previous = state.revisions.get(id);
    if (notice.revision !== undefined) {
      if (previous !== undefined && notice.revision <= previous) return;
      state.revisions.set(id, notice.revision);
    }
  }
  if (notice.severity === "error") {
    markExternalEngineFailureTerminal(runtime, notice.failure);
    await clearExternalEngineRetry(runtime, traceContext, events);
    return;
  }
  state.active = true;
  state.retryCount += 1;
  const attempt = notice.failure.attempt ?? state.retryCount;
  const event = runtime.createEvent(
    SessionEventType.ExternalEngineFailureUpdated,
    { failure: { ...notice.failure, attempt }, retrying: true, attempt },
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
  // 失败元数据已由 adapter 经 onFailure 归一交付；这里不再读取 session_info_update._meta。
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
      ) {
        plan.document = { id: document.planId, markdown: document.content };
        const turn = planTurns.get(runtime);
        if (turn) turn.documentUpdated = true;
      } else if (document.type === "items") plan.items = planItems(document.items);
      // 不读取外部引擎提供的任意 file URI；仅消费结构化内容。
      else return;
    } else if (previous.document?.id === update.planId) {
      delete plan.document;
      delete plan.startWithoutReview;
    } else return;
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
    onFailure: (notice) => publishExternalEngineFailureNotice(runtime, notice, traceContext),
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
    ...externalEngineFailureLogFields(failure),
  });
}

/** 日志只记录分类与标识；上游摘要与 URL 只进入界面诊断，不落盘。 */
export function externalEngineFailureLogFields(
  failure: EngineConnectionFailure,
): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean | undefined> = {
    code: failure.code,
    method: failure.method,
    rpcCode: failure.rpcCode,
    httpStatus: failure.httpStatus,
    requestId: failure.requestId,
    failureId: failure.failureId,
    retryable: failure.retryable,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

export async function publishExternalEngineConfig(
  runtime: AgentRuntimeInternal,
  options: EngineConfigOption[],
  traceContext: TraceContext,
): Promise<void> {
  rememberPlanExitValues(runtime, options);
  await persistExternalEngineConfig(runtime, options);
  runtime.engineConfigOptions = structuredClone(options);
  await publishExternalEngineConfigState(
    runtime,
    runtime.engineConfigState === "connecting" ? "connecting" : "ready",
    traceContext,
  );
  // 原生模式离开 Plan 后，“无审批开始执行”入口失去前提，由 owner 收回。
  const plan = plans.get(runtime);
  const option = nativePlanModeOption(runtime);
  if (plan?.startWithoutReview && option?.currentValue !== NATIVE_PLAN_MODE_VALUE) {
    const next = { ...plan, updatedAt: Date.now() };
    delete next.startWithoutReview;
    await publishPlan(runtime, planStateSchema.parse(next), traceContext);
  }
}

export async function publishExternalEngineConfigState(
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
      // 进入计划前的模式值；冷恢复后计划审批仍按原模式选择保留上下文的原生选项。
      ...(planExitValues.get(runtime) ? { planExitValues: planExitValues.get(runtime) } : {}),
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
    const exits = record(saved.planExitValues);
    const restoredExits = Object.fromEntries(
      Object.entries(exits).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1] !== NATIVE_PLAN_MODE_VALUE,
      ),
    );
    if (Object.keys(restoredExits).length > 0) planExitValues.set(runtime, restoredExits);
  }
  const plan = planStateSchema.safeParse(
    entries?.findLast((entry) => entry.type === PLAN_ENTRY_TYPE)?.data,
  );
  if (plan.success) {
    plans.set(runtime, plan.data);
    if (traceContext) await publishPlan(runtime, plan.data, traceContext);
  }
}
