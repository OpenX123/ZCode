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
  type EngineConfigOption,
  type EngineConnectionFailure,
} from "@zcode/shared";
import { closeAcpProcess } from "../exec/acp-process.js";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CANCEL_GRACE_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 30000;
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ExternalEngineConnectionError({ code: "protocol" }, "Invalid ACP object");
  return value as JsonObject;
}
function configOptions(value: unknown): EngineConfigOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid ACP config options");
  const parsed = engineConfigOptionSchema.array().safeParse(value);
  if (!parsed.success) throw new ExternalEngineConnectionError({ code: "protocol" });
  return parsed.data;
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
  private initialUpdates: Array<{ sessionId: unknown; update: JsonObject }> = [];
  get healthy(): boolean {
    return !this.failure;
  }
  private async update(params: JsonObject): Promise<void> {
    if (!this.active || params.sessionId !== this.externalSessionId) return;
    const update = object(params.update);
    // session/load 重放的是原生历史；YCode 已有 transcript，只接纳配置与元数据。
    if (
      this.loadingHistory &&
      ![
        "config_option_update",
        "available_commands_update",
        "session_info_update",
        "usage_update",
      ].includes(String(update.sessionUpdate))
    )
      return;
    if (update.sessionUpdate === "config_option_update")
      await this.active.onConfigOptions(configOptions(update.configOptions));
    else await this.active.onUpdate(update);
  }
  constructor(child: ChildProcessWithoutNullStreams) {
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
          this.pending.delete(frame.id);
          if (frame.error)
            request.reject(this.requestError(request.method, object(frame.error).code));
          else request.resolve(object(frame.result));
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
    const rpcCode = typeof value === "number" && Number.isInteger(value) ? value : undefined;
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
    return new ExternalEngineConnectionError({ code, method, rpcCode });
  }
  private async permission(frame: JsonObject): Promise<void> {
    const params = object(frame.params);
    if (!this.active || params.sessionId !== this.externalSessionId) {
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
  async prepare(input: ExternalEngineSessionInput): Promise<void> {
    await this.execute(input);
  }
  async run(input: ExternalEngineTurnInput): Promise<ExternalEngineTurnResult> {
    return (await this.execute(input, input.prompt))!;
  }
  private async execute(
    input: ExternalEngineSessionInput,
    prompt?: ExternalEngineTurnInput["prompt"],
  ): Promise<ExternalEngineTurnResult | undefined> {
    if (this.active) throw new Error("Concurrent ACP turn");
    this.active = input;
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
      if (!this.externalSessionId) {
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
          const initialized = await this.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "ycode", version: "1" },
          });
          const capabilities = initialized.agentCapabilities as
            | { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } }
            | undefined;
          let method: NonNullable<EngineConnectionFailure["method"]> = !input.externalSessionId
            ? "session/new"
            : capabilities?.loadSession && !capabilities.sessionCapabilities?.resume
              ? "session/load"
              : "session/resume";
          const params = {
            cwd: input.cwd,
            mcpServers: [],
            ...(input.externalSessionId ? { sessionId: input.externalSessionId } : {}),
          };
          this.loadingHistory = method === "session/load";
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
          if (input.externalSessionId && id !== input.externalSessionId)
            throw new ExternalEngineConnectionError(
              { code: "protocol" },
              "ACP resumed a different session",
            );
          this.externalSessionId = id;
          await input.onSession(id);
          let restoredOptions = await this.initialConfigOptions(
            configOptions(response.configOptions),
          );
          // ACP 缺省仍是 Manual，不会继承终端切换的 Auto；仅给未确认模式的新 Claude 会话选默认值。
          // 复用原生配置 RPC，并接纳其模型限制后的实际值；已有会话和用户选择继续走恢复路径。
          if (
            input.engine === "claude-code" &&
            !input.externalSessionId &&
            !input.configValues?.some((saved) => saved.id === "mode") &&
            restoredOptions.some(
              (option) =>
                option.id === "mode" &&
                option.currentValue === "default" &&
                option.options.some((item) => item.value === "auto"),
            )
          )
            restoredOptions = await this.initialConfigOptions(
              await this.setConfigOption("mode", "auto"),
            );
          for (const saved of input.configValues ?? []) {
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
            input.configValues?.some(
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
          await input.onConfigOptions(restoredOptions);
          this.notifications = this.notifications.then(async () => {
            for (const update of this.initialUpdates) await this.update(update);
            this.initialUpdates = [];
            this.sessionReady = true;
            this.loadingHistory = false;
          });
          await this.notifications;
        } finally {
          clearTimeout(timer);
        }
      }
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
      return {
        stopReason: String(result.stopReason),
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
    }
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
