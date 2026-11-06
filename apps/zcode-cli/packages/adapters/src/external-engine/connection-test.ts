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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  let result: Awaited<ReturnType<ExternalEnginePort["runTurn"]>> | undefined;
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
      result = await port.runTurn({
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
        },
        // 原生失败只经 adapter 边界（failure.ts）归一后由 onFailure 交付，不再出现在 onUpdate；
        // 首个失败（含引擎仍在重试的 warning）即结束测试，不等待引擎自行重试。
        async onFailure(notice) {
          if (failure) return;
          failure = notice.failure;
          stop.abort();
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
    // typed 终态失败可能随 prompt 响应返回（stopReason 仍为 end_turn），同样按失败收尾。
    if (result?.failure) return { status: "failed", latencyMs: elapsed(), failure: result.failure };
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
