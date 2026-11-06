import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  ExternalEngineConnectionError,
  createRootTraceContext,
  type ExternalEnginePort,
} from "@zcode/contracts";
import {
  ENGINE_CONNECTION_TEST_REPLY_MAX_LENGTH,
  readExternalEngineFailure,
  type EngineConnectionFailure,
  type ExternalEngineConnectionTestResult,
  type ExternalSessionEngine,
} from "@zcode/shared";

export const ENGINE_CONNECTION_TEST_PROMPT = "Reply with OK";
const ENGINE_CONNECTION_TEST_TIMEOUT_MS = 90_000;
const EXPECTED_REPLY = /\bok(?:ay)?\b/i;
// AIR 失败分类到连接诊断分类；未知分类按请求失败展示。
const AIR_FAILURE_CODES: Record<string, EngineConnectionFailure["code"]> = {
  access: "authentication",
  connection: "transport",
  limit: "provider",
  service: "provider",
  request: "request",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 原生失败通知：Codex 的 codex.error 与两家 AIR sessionFailure；只保留脱敏后的结构化字段。 */
function nativeFailure(update: Record<string, unknown>): EngineConnectionFailure | undefined {
  if (update.sessionUpdate !== "session_info_update") return undefined;
  const meta = record(update._meta);
  const codexError = record(record(meta.codex).error);
  if (typeof codexError.message === "string")
    return readExternalEngineFailure(codexError, { code: "provider" });
  const airFailure = record(record(record(meta.jetbrains).air).sessionFailure);
  if (airFailure.severity !== "error" || typeof airFailure.title !== "string") return undefined;
  return readExternalEngineFailure(
    { message: airFailure.title },
    { code: AIR_FAILURE_CODES[String(airFailure.category)] ?? "request" },
  );
}

/**
 * 设置页「测试连接」：沿用正式 ACP 启动路径（同一 port、连接配置与环境规则），在临时 cwd 中建立
 * 一次性原生会话并发送最小 prompt。会话不进入 SQLite 或任务索引，拒绝一切工具权限；结束后关闭
 * 会话、回收进程树并删除临时目录。结果只含分类、耗时、脱敏摘要，不含密钥、原始帧或 stderr。
 */
export async function runExternalEngineConnectionTest(
  port: ExternalEnginePort,
  input: { engine: ExternalSessionEngine; connectionProfileId: string; signal: AbortSignal },
): Promise<ExternalEngineConnectionTestResult> {
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const sessionId = `connection-test-${randomUUID()}`;
  const cwd = await mkdtemp(join(tmpdir(), "ycode-engine-test-"));
  const stop = new AbortController();
  const timeout = setTimeout(
    () => stop.abort(new ExternalEngineConnectionError({ code: "timeout" })),
    ENGINE_CONNECTION_TEST_TIMEOUT_MS,
  );
  timeout.unref();
  let failure: EngineConnectionFailure | undefined;
  let reply = "";
  // 结束原因的优先级：原生失败 > 用户取消 > 超时；prompt 是否以异常收尾不改变该判定。
  const interrupted = (): ExternalEngineConnectionTestResult | undefined => {
    if (failure) return { status: "failed", latencyMs: elapsed(), failure };
    if (input.signal.aborted) return { status: "cancelled" };
    if (stop.signal.reason instanceof ExternalEngineConnectionError)
      return {
        status: "failed",
        latencyMs: elapsed(),
        failure: { code: "timeout", method: "session/prompt" },
      };
    return undefined;
  };
  try {
    const signal = AbortSignal.any([input.signal, stop.signal]);
    try {
      await port.runTurn({
        sessionId,
        engine: input.engine,
        connectionProfileId: input.connectionProfileId,
        cwd,
        signal,
        traceContext: createRootTraceContext(),
        prompt: [{ type: "text", text: ENGINE_CONNECTION_TEST_PROMPT }],
        async onSession() {},
        async onConfigOptions() {},
        async onUpdate(update) {
          const content = record(update.content);
          if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string")
            reply += content.text;
          const nativeError = nativeFailure(update);
          // 首个失败即结束测试，不等待引擎自行重试；终态以最先发现的失败为准。
          if (nativeError && !failure) {
            failure = nativeError;
            stop.abort();
          }
        },
        // 测试只验证连接，任何工具调用都拒绝。
        requestPermission: async () => ({ outcome: "cancelled" }),
      });
    } catch (error) {
      return (
        interrupted() ?? {
          status: "failed",
          latencyMs: elapsed(),
          failure: error instanceof ExternalEngineConnectionError ? error.failure : { code: "request" },
        }
      );
    }
    const ended = interrupted();
    if (ended) return ended;
    if (EXPECTED_REPLY.test(reply)) return { status: "success", latencyMs: elapsed() };
    // 部分引擎把最终请求错误作为正文返回；只展示与错误摘要同口径脱敏的首行。
    const preview = (readExternalEngineFailure({ message: reply.trim() }).message ?? "").slice(
      0,
      ENGINE_CONNECTION_TEST_REPLY_MAX_LENGTH,
    );
    return { status: "unexpectedReply", latencyMs: elapsed(), reply: preview };
  } finally {
    clearTimeout(timeout);
    await port.closeSession(sessionId).catch(() => {});
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
