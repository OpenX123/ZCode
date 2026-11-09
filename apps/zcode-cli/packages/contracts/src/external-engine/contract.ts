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
  /** 已宣告原生子会话发出的请求；缺省表示主会话。应答仍回到该子请求自身的 JSON-RPC id。 */
  childNativeSessionId?: string;
}
/**
 * adapter 归一后的原生子智能体事实（AIR 草案与 RFD 两种形态；细则见根仓
 * docs/desktop/external-agent-engines-spec.md「外部引擎原生子智能体」）。nativeSessionId 是幂等键。
 */
export type ExternalEngineSubagentEvent =
  | {
      type: "spawned";
      nativeSessionId: string;
      /** 直接父原生会话；缺省 = 主会话。 */
      parentNativeSessionId?: string;
      name: string;
      task?: string;
      prompt?: string;
      /** 原生声明可经 session/cancel 停止。 */
      cancellable: boolean;
      /** RFD：委派提示随后以 prompt 事件到达，子会话首条消息等它而不用 task。 */
      promptPending?: boolean;
    }
  | {
      type: "state";
      nativeSessionId: string;
      state: ExternalEngineSubagentState;
      error?: string;
    }
  /** 子会话收到的委派提示（RFD session_message 接收视图）。 */
  | { type: "prompt"; nativeSessionId: string; messageId: string; text: string }
  /** 子会话交回父会话的回答（RFD session_message 发送者为子会话）。 */
  | { type: "reply"; nativeSessionId: string; text: string };
export type ExternalEngineSubagentState =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";
export type ExternalEnginePermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };
/**
 * adapter 归一并脱敏后的失败通知：warning = 原生仍在重试，error = 本轮终态失败。
 * failure.failureId + revision 供 Runtime 幂等合并；原始 ACP 文本不越过 adapter。
 */
export interface ExternalEngineFailureNotice {
  severity: "warning" | "error";
  failure: EngineConnectionFailure;
  revision?: number;
}
/**
 * ACP `session/update {sessionUpdate: "notice"}` 的非致命提示（不是失败）：adapter 脱敏后交付，
 * message 与失败摘要同口径（首行、≤300 字），原始 title/description 不越过 adapter。
 */
export interface ExternalEngineNotice {
  severity: "info" | "warning" | "error";
  message: string;
}
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
  /** 结构化失败（typed sessionFailure 或 Codex 非 typed 错误）；缺省时 adapter 丢弃这类元数据。 */
  onFailure?: (notice: ExternalEngineFailureNotice) => Promise<void>;
  /** 非致命提示（ACP notice）；不设置重试状态。缺省时 adapter 丢弃。 */
  onNotice?: (notice: ExternalEngineNotice) => Promise<void>;
  requestPermission: (
    request: ExternalEnginePermissionRequest,
  ) => Promise<ExternalEnginePermissionOutcome>;
  /** 原生子智能体生命周期；缺省时 adapter 丢弃子智能体帧。 */
  onSubagent?: (event: ExternalEngineSubagentEvent) => Promise<void>;
  /** 已宣告子会话的普通 session/update（正文、思考、工具、usage）。 */
  onChildUpdate?: (nativeSessionId: string, update: Record<string, unknown>) => Promise<void>;
  /** 无正文诊断（如丢弃未知子会话 ID）；调用方只记 debug。 */
  onDiagnostic?: (event: string, fields: Record<string, string>) => void;
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
  /** prompt 响应携带的 typed 终态失败（stopReason 可能仍为 end_turn），调用方按请求失败收尾。 */
  failure?: EngineConnectionFailure;
}
/** 单一 session 进程所有者；runTurn 必须由调用方串行准入。 */
export interface ExternalEnginePort {
  prepareSession(input: ExternalEngineSessionInput): Promise<void>;
  /** 会话已有健康 adapter 连接；false 表示下一次准备会重新启动或恢复原生会话。 */
  isSessionConnected?(sessionId: string): boolean;
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
  /** 停止原生声明可取消的子会话当前工作（session/cancel）；未知或不可取消时抛 unsupported。 */
  cancelSubagent?(sessionId: string, nativeSessionId: string): Promise<void>;
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
