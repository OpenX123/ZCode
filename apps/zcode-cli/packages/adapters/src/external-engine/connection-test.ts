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
  ENGINE_CONNECTION_TEST_WARNINGS_MAX,
  readExternalEngineFailure,
  type EngineConnectionFailure,
  type ExternalEngineConnectionTestResult,
  type ExternalEngineConnectionTestWarning,
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
 * 会话、回收进程树并删除临时目录。结果只含分类、耗时、脱敏摘要与脱敏警告，不含密钥、原始帧或 stderr。
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
  const warnings: ExternalEngineConnectionTestWarning[] = [];
  // 警告已在 adapter 边界脱敏；去重并限量，只用于成功结果的附带提示。
  const addWarning = (message: string | undefined) => {
    if (!message || warnings.length >= ENGINE_CONNECTION_TEST_WARNINGS_MAX) return;
    if (warnings.some((warning) => warning.message === message)) return;
    warnings.push({ message });
  };
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
        // 原生失败只经 adapter 边界（failure.ts）归一后由 onFailure 交付，不再出现在 onUpdate。
        // 修复（反馈 7，Codex 能用却测试失败）：未声明 session.notices 时 Codex 把非致命 WarningEvent
        // （如 Model metadata not found）作为 severity=warning 的 typed failure 上报，旧逻辑见到首个
        // 失败即判失败。依据用户决策 Q8：只有 error 结束测试；warning（重试中或非致命）只收集为
        // 警告，成功仍以收到模型正常回复判定，引擎重试用尽会再发 error。
        async onFailure(notice) {
          if (failure) return;
          if (notice.severity !== "error") {
            addWarning(notice.failure.message);
            return;
          }
          failure = notice.failure;
          stop.abort();
        },
        // ACP notice 是非致命提示：warning / error 级收为警告，info 级（如上下文压缩）不提示。
        async onNotice(notice) {
          if (notice.severity !== "info") addWarning(notice.message);
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
    if (EXPECTED_REPLY.test(reply))
      return {
        status: "success",
        latencyMs: elapsed(),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
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
