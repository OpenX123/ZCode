import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ExternalEngineConnectionError,
  type ExternalEngineSessionInput,
  type ExternalEngineTurnInput,
  type ExternalEngineTurnResult,
  type ExternalEnginePermissionRequest,
} from "@zcode/contracts";
import {
  engineConfigOptionSchema,
  readExternalEngineFailure,
  type EngineConfigOption,
  type EngineConnectionFailure,
  type ExternalSessionEngine,
} from "@zcode/shared";
import { closeAcpProcess } from "../exec/acp-process.js";
import {
  AIR_SESSION_FAILURE_CAPABILITY_META,
  readPromptResultFailure,
  readSessionInfoFailure,
} from "./failure.js";
import { SUBAGENT_FRAME_KINDS, readSubagentFrame, type KnownSubagent } from "./subagent-frames.js";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CANCEL_GRACE_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 30000;
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
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
 */
function clientCapabilities(engine: ExternalEngineSessionInput["engine"]): JsonObject {
  return engine === "codex"
    ? {
        plan: {},
        subagents: {},
        _meta: { ...AIR_SESSION_FAILURE_CAPABILITY_META, terminal_output_delta: true },
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
function configOptions(value: unknown): EngineConfigOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid ACP config options");
  const parsed = engineConfigOptionSchema.array().safeParse(withoutNullValueDescriptions(value));
  if (!parsed.success) throw new ExternalEngineConnectionError({ code: "protocol" });
  return parsed.data;
}
type SessionMethod = NonNullable<EngineConnectionFailure["method"]>;
/** 已建立（或已预建）的原生会话；回调与配置恢复由 execute 继续完成。 */
interface OpenedSession {
  method: SessionMethod;
  initializeMs: number;
  /** 原生返回的配置目录（预建会话为已应用新会话默认值后的目录）。 */
  configOptions: unknown;
  /** 预建时已应用新会话默认配置（Claude Auto），领用时不再重复判断。 */
  defaultsApplied: boolean;
}
export class AcpConnection {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      method: EngineConnectionFailure["method"];
      resolve(value: JsonObject): void;
      reject(error: Error): void;
    }
  >();
  private buffer = "";
  private notifications: Promise<void> = Promise.resolve();
  private failure?: Error;
  private active?: ExternalEngineSessionInput;
  private child: ChildProcessWithoutNullStreams;
  private externalSessionId?: string;
  private sessionReady = false;
  private loadingHistory = false;
  private forking = false;
  private initialUpdates: Array<{ sessionId: unknown; update: JsonObject }> = [];
  private initialized?: Promise<JsonObject>;
  /**
   * 预建会话（spare）尚未被领用时的配置目录。领用前 sessionReady 保持 false：这段时间到达的通知
   * 留在 initialUpdates，领用会话的握手按初始通知缓冲规则把它们交给该会话，而不是因无 active 被丢弃。
   */
  private prebuilt?: { options: EngineConfigOption[] };
  /** 最近一次握手的阶段耗时（毫秒），只供 port 写本地性能事件，不含任何正文。 */
  lastHandshake?: {
    method: string;
    initializeMs: number;
    sessionMs: number;
    configRestoreMs: number;
  };
  /** 已宣告的原生子会话（连接级，跨轮保留；RFD 的 idle 子会话可被再次委派）。 */
  private subagents = new Map<string, KnownSubagent>();
  get healthy(): boolean {
    return !this.failure;
  }
  /** 已建立（或领用）的原生会话 ID；port 据此记录“从未提交 prompt 的草稿原生会话”。 */
  get nativeSessionId(): string | undefined {
    return this.prebuilt ? undefined : this.externalSessionId;
  }
  private diagnose(event: string, sessionId: unknown): void {
    this.active?.onDiagnostic?.(event, { nativeSessionId: String(sessionId) });
  }
  private async update(params: JsonObject): Promise<void> {
    if (!this.active) return;
    const sessionId = params.sessionId;
    const child = typeof sessionId === "string" && this.subagents.has(sessionId);
    if (sessionId !== this.externalSessionId && !child) {
      // 修复前所有非主会话更新都被静默丢弃；现在只丢未宣告的 ID，并留无正文诊断。
      this.diagnose("external_engine.subagent.unrouted_update", sessionId);
      return;
    }
    const update = object(params.update);
    if (SUBAGENT_FRAME_KINDS.has(String(update.sessionUpdate)) || child) {
      // load/fork 回放的原生历史不写 YCode 子会话；已持久化的子会话正文是唯一事实。
      if (this.loadingHistory) return;
      await this.subagentUpdate(String(sessionId), update);
      return;
    }
    // session/load 重放的是原生历史；YCode 已有 transcript，只接纳配置与元数据。
    if (
      this.loadingHistory &&
      ![
        "config_option_update",
        "available_commands_update",
        "session_info_update",
        "usage_update",
        "plan",
        "plan_update",
        "plan_removed",
      ].includes(String(update.sessionUpdate))
    )
      return;
    if (update.sessionUpdate === "config_option_update")
      await this.active.onConfigOptions(configOptions(update.configOptions));
    else {
      if (update.sessionUpdate === "session_info_update") {
        // load/fork 回放的旧请求错误不是本轮重试；保留标题等历史事实，不恢复活动诊断。
        const notice = this.loadingHistory ? undefined : readSessionInfoFailure(update);
        // 失败元数据在此归一脱敏后单独交付；Runtime 只从 session_info_update 读取标题。
        delete update._meta;
        if (notice) await this.active.onFailure?.(notice);
      }
      await this.active.onUpdate(update);
    }
  }
  private async subagentUpdate(sessionId: string, update: JsonObject): Promise<void> {
    const active = this.active!;
    if (!SUBAGENT_FRAME_KINDS.has(String(update.sessionUpdate))) {
      await active.onChildUpdate?.(sessionId, update);
      return;
    }
    if (!active.onSubagent) return;
    const result = readSubagentFrame(sessionId, this.externalSessionId!, update, this.subagents);
    if ("invalid" in result) {
      this.diagnose(`external_engine.subagent.invalid.${result.invalid}`, sessionId);
      return;
    }
    for (const event of result.events) {
      // 先登记再交付：Runtime 处理 spawned 期间到达的子会话更新必须可路由。
      if (event.type === "spawned")
        this.subagents.set(event.nativeSessionId, { cancellable: event.cancellable });
      await active.onSubagent(event);
    }
  }
  /** 停止原生声明可取消的子会话当前工作；结果以原生后续 state 为准。 */
  cancelSubagent(nativeSessionId: string): void {
    if (!this.subagents.get(nativeSessionId)?.cancellable)
      throw new ExternalEngineConnectionError({ code: "unsupported" });
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: nativeSessionId } });
  }
  constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly setup?: (connection: AcpConnection) => Promise<void>,
  ) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    // stderr 只消费，防止缓冲阻塞；官方 CLI 原始诊断可能含身份和用户数据。
    child.stderr.resume();
    child.on("error", () => this.fail(new ExternalEngineConnectionError({ code: "not_ready" })));
    child.on("exit", (code, signal) =>
      this.fail(
        new ExternalEngineConnectionError(
          { code: "transport" },
          `ACP adapter exited (${signal ? `signal ${signal}` : `code ${code}`})`,
        ),
      ),
    );
    child.stdin.on("error", () =>
      this.fail(new ExternalEngineConnectionError({ code: "transport" })),
    );
  }
  private fail(error: Error): void {
    if (this.failure) return;
    if (error instanceof ExternalEngineConnectionError && !error.failure.method) {
      const method = this.pending.values().next().value?.method;
      if (method)
        error = new ExternalEngineConnectionError({ ...error.failure, method }, error.message);
    }
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  private send(value: JsonObject): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private read(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.fail(new Error("ACP frame exceeds size limit"));
      void this.close();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
          throw new Error("ACP frame exceeds size limit");
        const frame = object(JSON.parse(line));
        if (frame.jsonrpc !== "2.0") throw new Error("Invalid ACP JSON-RPC version");
        if (typeof frame.method === "string") {
          // 权限请求不可排在通知队列后等待用户，以免阻塞普通 session/update。
          if (frame.method === "session/request_permission") {
            void this.permission(frame).catch((error: unknown) =>
              this.fail(error instanceof Error ? error : new Error("ACP permission failed")),
            );
          } else if (frame.method === "session/update") {
            this.notifications = this.notifications
              .then(async () => {
                const params = object(frame.params);
                if (!this.sessionReady) {
                  if (this.initialUpdates.length >= 1024)
                    throw new Error("Too many ACP initialization updates");
                  this.initialUpdates.push({
                    sessionId: params.sessionId,
                    update: object(params.update),
                  });
                  return;
                }
                await this.update(params);
              })
              .catch((error: unknown) =>
                this.fail(error instanceof Error ? error : new Error("ACP update failed")),
              );
          } else if (frame.id !== undefined)
            this.send({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32601, message: "Method not supported" },
            });
        } else if (typeof frame.id === "number") {
          const request = this.pending.get(frame.id);
          if (!request) continue;
          const hasError = Object.hasOwn(frame, "error");
          if (hasError === Object.hasOwn(frame, "result")) throw new Error("Invalid ACP response");
          // 先校验再删除在途项；否则畸形响应抛错后 fail 无法拒绝无超时的 prompt。
          const response = hasError
            ? this.requestError(request.method, object(frame.error))
            : object(frame.result);
          this.pending.delete(frame.id);
          if (response instanceof ExternalEngineConnectionError) request.reject(response);
          else request.resolve(response);
        } else throw new Error("Invalid ACP frame");
      } catch {
        this.fail(new ExternalEngineConnectionError({ code: "protocol" }, "Invalid ACP frame"));
        void this.close();
      }
    }
  }
  private requestError(
    method: EngineConnectionFailure["method"],
    value: unknown,
  ): ExternalEngineConnectionError {
    const source = object(value);
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
  private async permission(frame: JsonObject): Promise<void> {
    const params = object(frame.params);
    // 权限请求不排队，但线上顺序里它晚于宣告子会话的 spawned 通知；非主 ID 尚未登记时先等已到达的
    // 通知处理完再判定，否则子会话的首个请求会被误判为未知 ID 而取消。
    if (
      params.sessionId !== this.externalSessionId &&
      !(typeof params.sessionId === "string" && this.subagents.has(params.sessionId))
    )
      await this.notifications;
    const childSessionId =
      typeof params.sessionId === "string" && this.subagents.has(params.sessionId)
        ? params.sessionId
        : undefined;
    if (
      this.forking ||
      !this.active ||
      (params.sessionId !== this.externalSessionId && !childSessionId)
    ) {
      if (this.active && params.sessionId !== this.externalSessionId)
        this.diagnose("external_engine.subagent.unrouted_permission", params.sessionId);
      this.send({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
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
    const outcome = await this.active.requestPermission({
      toolCall: toolCall as ExternalEnginePermissionRequest["toolCall"],
      options,
      ...(childSessionId ? { childNativeSessionId: childSessionId } : {}),
    });
    if (
      outcome.outcome === "selected" &&
      !options.some((option) => option.optionId === outcome.optionId)
    )
      throw new Error("Invalid ACP permission response");
    this.send({ jsonrpc: "2.0", id: frame.id, result: { outcome } });
  }
  async request(
    method: NonNullable<EngineConnectionFailure["method"]>,
    params: JsonObject,
  ): Promise<JsonObject> {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer =
        method === "session/prompt"
          ? undefined
          : setTimeout(() => {
              this.fail(new ExternalEngineConnectionError({ code: "timeout", method }));
              void this.close();
            }, HANDSHAKE_TIMEOUT_MS);
      timer?.unref();
      this.pending.set(id, {
        method,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  /**
   * initialize 与连接级 setup（Codex API Key 的 providers/set），每个进程只做一次；
   * 预建会话在补位时完成，领用后不再重复。
   */
  initialize(engine: ExternalEngineSessionInput["engine"]): Promise<JsonObject> {
    this.initialized ??= (async () => {
      const initialized = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: clientCapabilities(engine),
        clientInfo: { name: "ycode", version: "1" },
      });
      await this.setup?.(this);
      return initialized;
    })();
    return this.initialized;
  }
  /**
   * 预建会话（docs/desktop/external-agent-engines-spec.md「预建会话（spare）」）：initialize → 在 cwd
   * session/new → 新会话默认配置（Claude Auto），从不提交 prompt。此时还没有 YCode 会话，不调用任何
   * 会话回调；原生 ID、配置目录与领用前到达的通知由领用会话的 prepare 交付。
   * 依据：Claude adapter 的 session/new 需拉起官方 CLI 并等待其初始化（本机约 1.5s），只预热到
   * initialize 时命中仍需约 1.76s；本机实测两家未提交 prompt 的会话关闭后都不留下原生会话历史。
   */
  async prebuild(engine: ExternalSessionEngine, cwd: string): Promise<void> {
    if (this.active || this.externalSessionId)
      throw new Error("ACP connection already has a session");
    const options = await this.withHandshakeTimeout(async () => {
      const opened = await this.openSession({ engine, cwd });
      return this.newSessionDefaults(
        engine,
        undefined,
        await this.initialConfigOptions(configOptions(opened.configOptions)),
      );
    });
    this.prebuilt = { options };
  }
  async prepare(input: ExternalEngineSessionInput): Promise<void> {
    await this.execute(input);
  }
  async fork(input: ExternalEngineSessionInput, parentExternalSessionId: string): Promise<string> {
    if (this.externalSessionId)
      throw new ExternalEngineConnectionError({ code: "configuration", method: "session/fork" });
    await this.execute(input, undefined, parentExternalSessionId);
    if (!this.externalSessionId)
      throw new ExternalEngineConnectionError({ code: "protocol", method: "session/fork" });
    return this.externalSessionId;
  }
  async run(input: ExternalEngineTurnInput): Promise<ExternalEngineTurnResult> {
    return (await this.execute(input, input.prompt))!;
  }
  private async execute(
    input: ExternalEngineSessionInput,
    prompt?: ExternalEngineTurnInput["prompt"],
    parentExternalSessionId?: string,
  ): Promise<ExternalEngineTurnResult | undefined> {
    if (this.active) throw new Error("Concurrent ACP turn");
    this.active = input;
    this.forking = Boolean(parentExternalSessionId);
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (!prompt) {
        this.fail(
          input.signal.reason instanceof Error
            ? input.signal.reason
            : new Error("ACP preparation cancelled"),
        );
        void this.close();
        return;
      }
      if (this.externalSessionId && !this.failure) {
        try {
          this.send({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: this.externalSessionId },
          });
        } catch {
          /* 退出会统一拒绝 pending。 */
        }
      }
      cancellationTimer = setTimeout(() => {
        this.fail(new ExternalEngineConnectionError({ code: "timeout", method: "session/prompt" }));
        void this.close();
      }, CANCEL_GRACE_MS);
      cancellationTimer.unref();
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (input.signal.aborted) throw input.signal.reason;
      if (!this.externalSessionId || this.prebuilt)
        await this.withHandshakeTimeout(() => this.handshake(input, parentExternalSessionId));
      if (input.signal.aborted) {
        cancel();
        throw input.signal.reason;
      }
      if (!prompt) return;
      const result = await this.request("session/prompt", {
        sessionId: this.externalSessionId,
        prompt,
      });
      await this.notifications;
      if (this.failure) throw this.failure;
      // Codex 在尚无 token 统计时返回 usage:null；这不是断联，不能因此回收已停止的健康会话。
      const usage = result.usage == null ? undefined : object(result.usage);
      // typed 终态失败随 stopReason=end_turn 返回，必须交给 Runtime 按请求失败收尾。
      const failure = readPromptResultFailure(result);
      return {
        stopReason: String(result.stopReason),
        ...(failure ? { failure } : {}),
        ...(usage
          ? {
              usage: {
                inputTokens: Number(usage.inputTokens ?? 0),
                outputTokens: Number(usage.outputTokens ?? 0),
                cachedReadTokens: Number(usage.cachedReadTokens ?? 0),
                cachedWriteTokens: Number(usage.cachedWriteTokens ?? 0),
              },
            }
          : {}),
      };
    } finally {
      input.signal.removeEventListener("abort", cancel);
      clearTimeout(cancellationTimer);
      this.active = undefined;
      this.forking = false;
    }
  }
  /** 握手整体超时：卡住的阶段以结构化 timeout 失败并回收进程，不让准备无限等待。 */
  private async withHandshakeTimeout<T>(run: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      this.fail(
        new ExternalEngineConnectionError({
          code: "timeout",
          method: this.pending.values().next().value?.method ?? "initialize",
        }),
      );
      void this.close();
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    try {
      return await run();
    } finally {
      clearTimeout(timer);
    }
  }
  /** initialize 后建立原生会话（new / resume / load / fork）；不调用会话回调。 */
  private async openSession(
    input: Pick<ExternalEngineSessionInput, "engine" | "cwd" | "externalSessionId">,
    parentExternalSessionId?: string,
  ): Promise<OpenedSession> {
    const initializeStartedAt = Date.now();
    const initialized = await this.initialize(input.engine);
    const initializeMs = Date.now() - initializeStartedAt;
    const capabilities = initialized.agentCapabilities as
      | { loadSession?: boolean; sessionCapabilities?: { resume?: unknown; fork?: unknown } }
      | undefined;
    if (parentExternalSessionId && !capabilities?.sessionCapabilities?.fork)
      throw new ExternalEngineConnectionError({ code: "unsupported", method: "session/fork" });
    let method: SessionMethod = parentExternalSessionId
      ? "session/fork"
      : !input.externalSessionId
        ? "session/new"
        : capabilities?.loadSession && !capabilities.sessionCapabilities?.resume
          ? "session/load"
          : "session/resume";
    const params = {
      cwd: input.cwd,
      mcpServers: [],
      ...(parentExternalSessionId || input.externalSessionId
        ? { sessionId: parentExternalSessionId ?? input.externalSessionId }
        : {}),
    };
    this.loadingHistory = method === "session/load" || method === "session/fork";
    let response: JsonObject;
    try {
      response = await this.request(method, params);
    } catch (error) {
      // 仅明确 method-not-found 才回退同一原生会话；业务错误不能靠换方法掩盖。
      if (
        !(error instanceof ExternalEngineConnectionError) ||
        error.failure.rpcCode !== -32601 ||
        method !== "session/resume" ||
        !capabilities?.loadSession
      )
        throw error;
      method = "session/load";
      this.loadingHistory = true;
      response = await this.request(method, params);
    }
    const id = response.sessionId ?? input.externalSessionId;
    if (typeof id !== "string") throw new Error("ACP session id missing");
    if (parentExternalSessionId && id === parentExternalSessionId)
      throw new ExternalEngineConnectionError(
        { code: "protocol", method: "session/fork" },
        "ACP fork reused parent session",
      );
    if (input.externalSessionId && id !== input.externalSessionId)
      throw new ExternalEngineConnectionError(
        { code: "protocol" },
        "ACP resumed a different session",
      );
    this.externalSessionId = id;
    return { method, initializeMs, configOptions: response.configOptions, defaultsApplied: false };
  }
  /** 会话握手：建立或领用原生会话 → onSession → 配置恢复 → onConfigOptions → 回放初始通知。 */
  private async handshake(
    input: ExternalEngineSessionInput,
    parentExternalSessionId?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    let opened: OpenedSession;
    if (this.prebuilt) {
      // 预建会话只服务新会话（port 只在新会话时领用）；resume/load/fork 必须走原生恢复语义。
      if (input.externalSessionId || parentExternalSessionId)
        throw new Error("Prebuilt ACP session only serves a new session");
      // 领用：initialize 与 session/new 已在补位时完成，这里只交付缓存的原生 ID 与配置目录。
      opened = {
        method: "session/new",
        initializeMs: 0,
        configOptions: this.prebuilt.options,
        defaultsApplied: true,
      };
      this.prebuilt = undefined;
    } else opened = await this.openSession(input, parentExternalSessionId);
    await input.onSession(this.externalSessionId!);
    const configStartedAt = Date.now();
    let restoredOptions = await this.initialConfigOptions(configOptions(opened.configOptions));
    if (!opened.defaultsApplied && !parentExternalSessionId && !input.externalSessionId)
      restoredOptions = await this.newSessionDefaults(
        input.engine,
        input.configValues,
        restoredOptions,
      );
    // 会话自带的已保存配置（含显式模式）始终在默认值之后下发；领用预建会话时同样如此。
    restoredOptions = await this.restoreConfigValues(input.configValues, restoredOptions);
    await input.onConfigOptions(restoredOptions);
    this.lastHandshake = {
      method: opened.method,
      initializeMs: opened.initializeMs,
      // 领用预建会话时 initialize 与 session/new 都已提前完成，这里只剩 onSession 持久化的真实耗时。
      sessionMs: configStartedAt - startedAt - opened.initializeMs,
      configRestoreMs: Date.now() - configStartedAt,
    };
    this.notifications = this.notifications.then(async () => {
      for (const update of this.initialUpdates) await this.update(update);
      this.initialUpdates = [];
      this.sessionReady = true;
      this.loadingHistory = false;
    });
    await this.notifications;
  }
  /**
   * ACP 缺省仍是 Manual，不会继承终端切换的 Auto；仅给未确认模式的新 Claude 会话选默认值。
   * 复用原生配置 RPC，并接纳其模型限制后的实际值；已有会话和用户选择继续走恢复路径。
   */
  private async newSessionDefaults(
    engine: ExternalSessionEngine,
    configValues: ExternalEngineSessionInput["configValues"],
    options: EngineConfigOption[],
  ): Promise<EngineConfigOption[]> {
    if (
      engine !== "claude-code" ||
      configValues?.some((saved) => saved.id === "mode") ||
      !options.some(
        (option) =>
          option.id === "mode" &&
          option.currentValue === "default" &&
          option.options.some((item) => item.value === "auto"),
      )
    )
      return options;
    return this.initialConfigOptions(await this.setConfigOption("mode", "auto"));
  }
  /** 按 Runtime 上次确认的选择恢复配置；缺失值明确失败，不静默回落。 */
  private async restoreConfigValues(
    configValues: ExternalEngineSessionInput["configValues"],
    options: EngineConfigOption[],
  ): Promise<EngineConfigOption[]> {
    let restoredOptions = options;
    for (const saved of configValues ?? []) {
      const option = restoredOptions.find((item) => item.id === saved.id);
      if (!option)
        throw new ExternalEngineConnectionError(
          { code: "configuration", method: "session/set_config_option" },
          "Saved ACP config option is unavailable",
        );
      if (option.currentValue === saved.value) continue;
      if (!option.options.some((item) => item.value === saved.value))
        throw new ExternalEngineConnectionError(
          { code: "configuration", method: "session/set_config_option" },
          "Saved ACP config value is unavailable",
        );
      restoredOptions = await this.initialConfigOptions(
        await this.setConfigOption(saved.id, saved.value),
      );
    }
    if (
      configValues?.some(
        (saved) =>
          !restoredOptions.some(
            (option) => option.id === saved.id && option.currentValue === saved.value,
          ),
      )
    )
      throw new ExternalEngineConnectionError({
        code: "configuration",
        method: "session/set_config_option",
      });
    return restoredOptions;
  }
  private async initialConfigOptions(options: EngineConfigOption[]): Promise<EngineConfigOption[]> {
    await this.notifications;
    // resume 与 set_config_option 可先通知后响应；按同一队列消费，防止旧默认值覆盖恢复结果。
    this.initialUpdates = this.initialUpdates.filter((params) => {
      if (
        params.sessionId !== this.externalSessionId ||
        params.update.sessionUpdate !== "config_option_update"
      )
        return true;
      options = configOptions(params.update.configOptions);
      return false;
    });
    return options;
  }
  async setConfigOption(configId: string, value: string): Promise<EngineConfigOption[]> {
    if (!this.externalSessionId) throw new ExternalEngineConnectionError({ code: "not_ready" });
    const result = await this.request("session/set_config_option", {
      sessionId: this.externalSessionId,
      configId,
      value,
    });
    return configOptions(result.configOptions);
  }
  async close(): Promise<void> {
    this.fail(new Error("ACP adapter closed"));
    await closeAcpProcess(this.child);
  }
}
