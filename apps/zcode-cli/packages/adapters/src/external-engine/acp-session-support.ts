import {
  ExternalEngineConnectionError,
  type ExternalEngineSessionInput,
  type ExternalEnginePermissionRequest,
} from "@zcode/contracts";
import {
  engineConfigOptionSchema,
  readExternalEngineFailure,
  type EngineConfigOption,
  type EngineConnectionFailure,
  type ExternalSessionEngine,
} from "@zcode/shared";
import { AIR_SESSION_FAILURE_CAPABILITY_META } from "./failure.js";

/** AcpConnection 的无状态协议细则与轮间推送缓存；拆出只为保持连接主体在文件行数上限内。 */
type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ExternalEngineConnectionError({ code: "protocol" }, "Invalid ACP object");
  return value as JsonObject;
}

/**
 * typed failure 扩展挂在 JetBrains AIR 客户端标记下，声明即被 adapter 视为 AIR 客户端
 * （核查见 docs/desktop/native-plan-errors-spec.md「能力声明」）：
 * - Codex 只改变工具行呈现；同时声明非 AIR 专属的 terminal_output_delta，让终端输出仍按
 *   既有 `_meta.terminal_output_delta` 追加，避免 AIR 下命令输出整段丢失。
 * - Claude 的 AIR 会去掉审批预览/读取结果正文并切换子智能体协议，因此仍不声明。
 * 1.1.0 两家都声明 `subagents`：Codex 作为 AIR 客户端得到 AIR 草案形态，Claude 得到 RFD 形态
 * （docs/desktop/external-agent-engines-spec.md「外部引擎原生子智能体」）。
 * 修复：codex-acp 2.2.2 的 SDK schema 剥离 `subagents`，只认 AIR `nativeSubagentSessions`，此前 Codex
 * 子智能体一直走旧工具行；该能力须与启动时启用的 `multi_agent_v2`（adapter-env.ts）成对。
 */
const CODEX_AIR_CAPABILITY_META = {
  jetbrains: {
    air: {
      ...AIR_SESSION_FAILURE_CAPABILITY_META.jetbrains.air,
      capabilities: [
        ...AIR_SESSION_FAILURE_CAPABILITY_META.jetbrains.air.capabilities,
        "nativeSubagentSessions",
      ],
    },
  },
};
export function clientCapabilities(engine: ExternalEngineSessionInput["engine"]): JsonObject {
  return engine === "codex"
    ? {
        plan: {},
        subagents: {},
        _meta: { ...CODEX_AIR_CAPABILITY_META, terminal_output_delta: true },
      }
    : { plan: {}, subagents: {} };
}
/**
 * 本机 Windows 实测：Codex 模型目录里第三方网关模型的选项值返回 `description: null`，严格 schema 只接受
 * 字符串或缺省，整份 configOptions 校验失败后握手以 protocol 报"不兼容的响应"，Codex 无法连接。
 * ACP 帧在 adapter 边界归一：值级 description 为 null 视同缺省，其余字段仍按 schema 严格校验。
 */
function withoutNullValueDescriptions(value: unknown[]): unknown[] {
  return value.map((option) => {
    if (option === null || typeof option !== "object" || Array.isArray(option)) return option;
    const record = option as Record<string, unknown>;
    if (!Array.isArray(record.options)) return option;
    return {
      ...record,
      options: record.options.map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const { description, ...rest } = entry as Record<string, unknown>;
        return description === null ? rest : entry;
      }),
    };
  });
}
export function configOptions(value: unknown): EngineConfigOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid ACP config options");
  const parsed = engineConfigOptionSchema.array().safeParse(withoutNullValueDescriptions(value));
  if (!parsed.success) throw new ExternalEngineConnectionError({ code: "protocol" });
  return parsed.data;
}

/** JSON-RPC 错误响应 → 结构化连接失败；畸形错误对象按 protocol 失败。 */
export function acpRequestError(
  method: EngineConnectionFailure["method"],
  source: JsonObject,
): ExternalEngineConnectionError {
  if (
    typeof source.code !== "number" ||
    !Number.isInteger(source.code) ||
    typeof source.message !== "string"
  )
    throw new ExternalEngineConnectionError({ code: "protocol", method });
  const rpcCode = source.code;
  const code =
    rpcCode === -32000
      ? "authentication"
      : rpcCode === -32002
        ? "session_not_found"
        : rpcCode === -32601
          ? "unsupported"
          : rpcCode === -32602
            ? "configuration"
            : "request";
  const failure = readExternalEngineFailure(source, { code, method, rpcCode });
  return new ExternalEngineConnectionError(failure, failure.message);
}

const CLAUDE_ORIGIN_META_KEY = "_claude/origin";
const CONTINUATION_ORIGIN_KIND = "task-notification";
/**
 * 引擎自发续跑的收尾标记（2026-11-19 Claude 0.95.0 真实帧）：每轮模型输出以带 cost 的 usage_update 结束，
 * `_meta["_claude/origin"].kind` 为 human（用户轮）或 task-notification（后台任务唤醒的自发轮）。
 */
export function isContinuationEnd(update: JsonObject): boolean {
  if (update.sessionUpdate !== "usage_update") return false;
  const meta = update._meta;
  if (meta === null || typeof meta !== "object") return false;
  const origin = (meta as JsonObject)[CLAUDE_ORIGIN_META_KEY];
  return (
    origin !== null &&
    typeof origin === "object" &&
    (origin as JsonObject).kind === CONTINUATION_ORIGIN_KIND
  );
}

// ACP 在 prompt 结束后仍可能发元数据，这些帧没有后续的续跑收尾信号。
const PASSIVE_IDLE_UPDATES = new Set([
  "available_commands_update",
  "config_option_update",
  "current_mode_update",
  "session_info_update",
  "notice",
  "usage_update",
]);

export function isIdleContinuationUpdate(update: JsonObject): boolean {
  return !PASSIVE_IDLE_UPDATES.has(String(update.sessionUpdate)) || isContinuationEnd(update);
}

/**
 * 子智能体命名约束（docs/desktop/external-agent-engines-spec.md「跨轮观察与引擎自发续跑」）：
 * 原生帧只带模型自填的名称，未约束时多为类型名或空；追加为系统/开发者指令，界面直接展示。
 */
export const SUBAGENT_NAMING_INSTRUCTIONS: Record<ExternalSessionEngine, string> = {
  "claude-code":
    "When you delegate work with the Agent tool, set its description to a short English title of 2-5 words that starts with the subagent's role, for example \"Backend auth fix\", \"Frontend layout check\", \"Analyst log review\" or \"Reviewer scoped check\". Give parallel subagents distinct titles.",
  codex:
    "When you spawn a subagent, begin its task prompt with a first line `Title: <title>` where <title> is a short English title of 2-5 words that starts with the subagent's role, for example \"Backend auth fix\", \"Frontend layout check\", \"Analyst log review\" or \"Reviewer scoped check\". Give parallel subagents distinct titles.",
};

/** 轮间缓存上限：超出只记诊断（不判连接故障），防止无人消费时无限增长。 */
const MAX_IDLE_UPDATES = 4096;

/**
 * 修复：轮间（无 active）引擎主动推送曾被直接丢弃、轮间权限一律回 cancelled。这里按到达顺序缓存已路由推送，
 * 每段空闲期只边沿唤醒一次 Runtime（准入 continuation），并让轮间权限请求等到下一次会话操作接管。
 */
export class IdleActivity {
  private updates: JsonObject[] = [];
  private diagnostics: string[] = [];
  private signaled = false;
  private waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private listener?: () => void;

  /** 以最近一次会话操作传入的回调为准。 */
  listen(listener: (() => void) | undefined): void {
    if (listener) this.listener = listener;
  }
  buffer(params: JsonObject, routed: boolean): void {
    if (!routed) {
      this.diagnostics.push("external_engine.subagent.unrouted_update");
      return;
    }
    if (this.updates.length >= MAX_IDLE_UPDATES) {
      this.diagnostics.push("external_engine.idle_update.overflow");
      return;
    }
    this.updates.push(params);
    this.signal();
  }
  /** 轮间权限请求：唤醒 Runtime，等某次会话操作 claim 后再交给它。 */
  waitForActive(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.signal();
    });
  }
  get pending(): boolean {
    return this.updates.length > 0 || this.waiters.length > 0;
  }
  /** 进入会话操作：返回待回放推送与空闲期诊断，唤醒等待的权限请求，复位边沿。 */
  claim(): { updates: JsonObject[]; diagnostics: string[] } {
    this.signaled = false;
    const claimed = { updates: this.updates.splice(0), diagnostics: this.diagnostics.splice(0) };
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
    return claimed;
  }
  fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  private signal(): void {
    if (this.signaled) return;
    this.signaled = true;
    this.listener?.();
  }
}


/** 严格校验 ACP 请求，保留原生选项 ID 与子会话来源。 */
export function readPermissionRequest(
  params: JsonObject,
  childSessionId: string | undefined,
): ExternalEnginePermissionRequest {
  const toolCall = object(params.toolCall);
  if (typeof toolCall.toolCallId !== "string" || !Array.isArray(params.options))
    throw new Error("Invalid ACP permission request");
  const options = params.options.map((value) => {
    const option = object(value);
    if (
      typeof option.optionId !== "string" ||
      typeof option.name !== "string" ||
      !["allow_once", "allow_always", "reject_once", "reject_always"].includes(
        String(option.kind),
      )
    )
      throw new Error("Invalid ACP permission option");
    return option as unknown as ExternalEnginePermissionRequest["options"][number];
  });
  return {
    toolCall: toolCall as ExternalEnginePermissionRequest["toolCall"],
    options,
    ...(childSessionId ? { childNativeSessionId: childSessionId } : {}),
  };
}
