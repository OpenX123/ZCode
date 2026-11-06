import type {
  EngineConfigOption,
  EngineConnectionFailure,
  ExternalSessionEngine,
} from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

export interface ExternalEnginePermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  name: string;
}
export interface ExternalEnginePermissionRequest {
  toolCall: Record<string, unknown> & { toolCallId: string };
  options: ExternalEnginePermissionOption[];
}
export type ExternalEnginePermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };
export interface ExternalEngineSessionInput {
  sessionId: string;
  engine: ExternalSessionEngine;
  externalSessionId?: string;
  /** 认证目录随会话固定，不能随应用默认连接变化。 */
  connectionProfileId?: string;
  onConnectionProfile?: (id: string) => Promise<void>;
  /** 仅在新连接初始化时恢复已确认的原生值，不作为可选目录。 */
  configValues?: Array<{ id: string; value: string }>;
  cwd: string;
  signal: AbortSignal;
  traceContext: TraceContext;
  onSession: (id: string) => Promise<void>;
  onConfigOptions: (options: EngineConfigOption[]) => Promise<void>;
  onUpdate: (update: Record<string, unknown>) => Promise<void>;
  requestPermission: (
    request: ExternalEnginePermissionRequest,
  ) => Promise<ExternalEnginePermissionOutcome>;
}
export interface ExternalEngineTurnInput extends ExternalEngineSessionInput {
  prompt: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
}
export interface ExternalEngineTurnResult {
  stopReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
}
/** 单一 session 进程所有者；runTurn 必须由调用方串行准入。 */
export interface ExternalEnginePort {
  prepareSession(input: ExternalEngineSessionInput): Promise<void>;
  /** 新连接沿用源身份，仅分叉原生上下文，不提交用户输入。 */
  forkSession?(
    input: ExternalEngineSessionInput & { parentExternalSessionId: string },
  ): Promise<string>;
  runTurn(input: ExternalEngineTurnInput): Promise<ExternalEngineTurnResult>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<EngineConfigOption[]>;
  closeSession(sessionId: string): Promise<void>;
}

/** 仅保留输入边界脱敏后的摘要与诊断字段，不保存原始 ACP message/data。 */
export class ExternalEngineConnectionError extends Error {
  readonly code: string;
  constructor(
    readonly failure: EngineConnectionFailure,
    safeMessage?: string,
  ) {
    super(
      safeMessage ??
        `External engine request failed (${failure.code}${failure.method ? `, ${failure.method}` : ""}${failure.rpcCode !== undefined ? `, RPC ${failure.rpcCode}` : ""})`,
    );
    this.name = "ExternalEngineConnectionError";
    this.code =
      failure.code === "not_ready" ? "engine_not_ready" : "external_engine_connection_failed";
  }
}
