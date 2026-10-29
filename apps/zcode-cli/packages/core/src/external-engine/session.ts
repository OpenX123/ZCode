import { persistGeneratedSessionTitle } from "../runtime/methods/session-title.js";
import { engineConfigOptionSchema, isExternalSessionEngine } from "@zcode/shared";
import {
  SessionEventType,
  ExternalEngineConnectionError,
  type ExternalEngineSessionInput,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import type { EngineConfigOption } from "@zcode/shared";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  await publishExternalEngineConfigState(runtime, "connecting", traceContext);
  try {
    const input = externalEngineSessionInput(runtime, new AbortController().signal, traceContext);
    await runtime.externalEnginePort!.prepareSession(input);
    await publishExternalEngineConfigState(runtime, "ready", traceContext);
  } catch (error) {
    await publishExternalEngineConfigError(runtime, error, traceContext);
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
    data: { engine: runtime.config.engine, engineConfigOptions: options },
  });
}

export async function restoreExternalEngineConfig(runtime: AgentRuntimeInternal): Promise<void> {
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: CONFIG_ENTRY_TYPE,
  });
  const saved = record(entries?.at(-1)?.data);
  if (saved.engine !== runtime.config.engine) return;
  // 只恢复已确认值；实际可选目录和就绪状态仍由原生 resume 决定。
  runtime.engineConfigOptions = engineConfigOptionSchema.array().parse(saved.engineConfigOptions);
}
