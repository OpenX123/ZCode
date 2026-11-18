import { uuidv7 } from "@zcode/shared";
import { createMessageId, type TraceContext } from "@zcode/contracts";
import {
  createRuntimeCommandId,
  type ExternalEngineContinuationRuntimeCommand,
} from "../runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../runtime/internal.js";

/**
 * 外部引擎自发续跑的准入与执行（根仓 docs/desktop/external-agent-engines-spec.md
 * 「跨轮观察与引擎自发续跑」）。owner 是父 Runtime 的命令队列：与 task-notification 同一串行准入，
 * 不新增 accepted queue；adapter 只负责缓存与边沿唤醒。
 */
const CONTINUATION_INPUT_TEXT = "Background work finished; the engine continued on its own.";
const CONTINUATION_INPUT_PRESENTATION = "task_notification";

/** 同一 Runtime 至多一条排队中的 continuation；执行开始时释放，之后的推送再唤醒新一轮。 */
const queued = new WeakSet<AgentRuntimeInternal>();

export function enqueueExternalEngineContinuation(runtime: AgentRuntimeInternal): void {
  if (runtime.shuttingDown || queued.has(runtime)) return;
  queued.add(runtime);
  runtime.logger?.info?.("External engine continuation enqueued", {
    event: "external_engine.continuation.enqueued",
    module: "core.external_engine",
    sessionId: runtime.sessionId,
  });
  runtime.enqueueRuntimeCommand({
    branchGeneration: runtime.branchGeneration,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "external-engine-continuation",
    priority: "next",
    traceContext: runtime.rootTraceContext,
  });
}

export async function runExternalEngineContinuationCommand(
  runtime: AgentRuntimeInternal,
  command: ExternalEngineContinuationRuntimeCommand,
  abortSignal: AbortSignal,
): Promise<void> {
  queued.delete(runtime);
  // 排队期间用户轮可能已先执行并消费了同一批推送；无未消费推送时不开空轮。
  if (
    runtime.shuttingDown ||
    !runtime.externalEnginePort?.hasPendingContinuation?.(runtime.sessionId)
  ) {
    runtime.logger?.debug("External engine continuation skipped", {
      event: "external_engine.continuation.skipped",
      module: "core.external_engine",
      sessionId: runtime.sessionId,
    });
    return;
  }
  const traceContext: TraceContext = command.traceContext;
  const messageID = createMessageId();
  // model-only 合成输入：界面按后台结果来源渲染“后台任务完成，继续处理”，不当作用户消息。
  await runtime.persistSyntheticUserNoticeForSession({
    messageID,
    metadata: { inputPresentation: CONTINUATION_INPUT_PRESENTATION, visibility: "model-only" },
    sessionId: runtime.sessionId,
    source: "background_task",
    text: CONTINUATION_INPUT_TEXT,
    traceContext,
    visibility: "model-only",
  });
  await runtime.executeTurnCommand(CONTINUATION_INPUT_TEXT, undefined, {
    abortSignal,
    externalEngineContinuation: true,
    inputId: uuidv7(),
    inputSource: "background_task",
    inputVisibility: "model-only",
    recordedInputMessageId: messageID,
    skipInputRecord: true,
    skipUserPromptSubmitHooks: true,
    traceContext,
  });
}
