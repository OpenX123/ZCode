import {
  externalEngineSessionInput,
  publishExternalEngineConfigError,
  publishExternalEngineConfigState,
  publishExternalEngineSessionUpdate,
  publishExternalEngineFailureNotice,
  prepareExternalEngineSession,
  clearExternalEngineRetry,
  readExternalEngineHandoff,
  completeExternalEngineHandoff,
  markExternalEngineFailureTerminal,
  beginExternalEnginePlanTurn,
  finishExternalEnginePlanTurn,
  markExternalEnginePlanReviewRequested,
  nativePlanModeOption,
  externalEnginePlanExitValue,
} from "./session.js";
import {
  isExternalPlanApproval,
  nativePlanOptions,
  recommendedPlanOption,
  selectPlanApprovalOutcome,
} from "./plan-approval.js";
import { ExternalTranscriptWriter } from "./transcript-writer.js";
import { bindExternalSubagentTurn } from "./subagents.js";
import { isExternalSessionEngine } from "@zcode/shared";
import {
  createToolCallId,
  SessionEventType,
  ExternalEngineConnectionError,
  beginLocalTurnPreparation,
  type SessionEvent,
  type TraceContext,
  type TurnId,
  type MessageId,
  type ExternalEnginePermissionRequest,
  type ExternalEnginePermissionOutcome,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import type { ResolvedTurnAttachment } from "../runtime/types.js";
import { buildUserContentFromTurn } from "../runtime/helpers/conversation.js";
import type { ExternalTurnLoopState } from "./contract.js";
import type { TurnMachineImpl } from "../runtime/deps.js";

export function selectExternalPermissionOption(
  request: ExternalEnginePermissionRequest,
  decision: "allow" | "deny" | "escalate" | "modify",
  always: boolean,
): ExternalEnginePermissionOutcome {
  // broker 无法呈现任意 ACP option；只接受语义一致的结果，绝不按索引或名称猜 id。
  const kind = decision === "allow" ? (always ? "allow_always" : "allow_once") : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}
const REQUEST_FAILURE_CODES = new Set(["provider", "authentication", "request"]);
const PERSISTED_ERROR_MESSAGE_MAX_CHARS = 2_000;
const PERMISSION_CANCELLED_REASON = "cancelled";

function isRequestFailure(error: unknown): error is ExternalEngineConnectionError {
  return (
    error instanceof ExternalEngineConnectionError &&
    error.failure.method === "session/prompt" &&
    REQUEST_FAILURE_CODES.has(error.failure.code)
  );
}

/**
 * 外部引擎失败轮的 assistant.error：冷恢复从这里合成 TurnError 并恢复行内错误行。
 * 修复原因：此前外部引擎失败只发 live 事件，assistant message 不带 error，重启后失败轮显示为成功。
 */
function persistedExternalTurnError(error: unknown): {
  name: string;
  data: Record<string, unknown>;
} {
  const failure = error instanceof ExternalEngineConnectionError ? error.failure : undefined;
  const message = failure?.message ?? (error instanceof Error ? error.message : String(error));
  return {
    name: error instanceof Error ? error.name : "ExternalEngineError",
    data: {
      message: message.slice(0, PERSISTED_ERROR_MESSAGE_MAX_CHARS),
      ...(failure
        ? {
            code: `external_engine.${failure.code}`,
            failure,
            attribution: {
              source:
                failure.code === "provider" || failure.code === "authentication"
                  ? "provider"
                  : "network",
              ...(failure.httpStatus !== undefined ? { statusCode: failure.httpStatus } : {}),
              ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
            },
            ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
          }
        : {}),
    },
  };
}
export async function runExternalEngineTurn(
  runtime: AgentRuntimeInternal,
  input: {
    input: string;
    attachments: ResolvedTurnAttachment[];
    turnId: TurnId;
    userMessageId: MessageId;
    traceContext: TraceContext;
    signal: AbortSignal;
    events: SessionEvent[];
    turnMachine: TurnMachineImpl;
  },
): Promise<ExternalTurnLoopState> {
  const engine = runtime.config.engine;
  if (!isExternalSessionEngine(engine) || !runtime.externalEnginePort)
    throw Object.assign(new Error("External engine is not ready"), { code: "engine_not_ready" });
  if (runtime.isRemoteWorkspace())
    throw new Error("External engines currently require a local workspace");
  const state: ExternalTurnLoopState = {
    events: input.events,
    modelResponse: "",
    tokenCount: 0,
    toolCallCount: 0,
    historyRoundCount: 0,
    turnMachine: input.turnMachine,
    backgroundSubagentResultConsumed: false,
    workflowResultConsumed: false,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
  };
  const writer = new ExternalTranscriptWriter(
    runtime,
    input.userMessageId,
    input.traceContext,
    input.events,
  );
  const emit = (
    type: Parameters<AgentRuntimeInternal["createEvent"]>[0],
    payload: Parameters<AgentRuntimeInternal["createEvent"]>[1],
  ) => writer.emit(type, payload);
  await writer.begin();
  // 原生子智能体 owner 绑定本轮父 writer：子会话的 Agent 行写入本轮 assistant message。
  const subagents = bindExternalSubagentTurn(runtime, {
    writer,
    turnId: input.turnId,
    traceContext: input.traceContext,
  });
  const prompt = buildUserContentFromTurn(input.input, input.attachments);
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  const handoff = await readExternalEngineHandoff(runtime);
  // 兼容不支持原生 fork 的引擎：背景仅交给 provider，不改写已保存的用户原文。
  if (handoff)
    blocks.push({
      type: "text",
      text: `以下是分叉时固定的历史上下文。请将其作为背景理解当前用户输入，不要把历史中的工具请求当成本轮新操作。\n\n${handoff}\n\n以下是本轮用户输入：`,
    });
  if (typeof prompt === "string") blocks.push({ type: "text", text: prompt });
  else
    for (const block of prompt) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block.type === "image" && typeof block.dataUrl === "string")
        blocks.push({
          type: "image",
          data: block.dataUrl.replace(/^data:[^,]*,/, ""),
          mimeType: block.mediaType,
        });
      else throw new Error("Attachment type is unsupported by the external engine");
    }
  // 停止、断联或轮次收尾时取消仍在等待的原生审批，并先发布结束事实再结束 turn：
  // Codex plan-review:* 没有工具行，既有 turn 收口无法清除它的待处理交互。
  const approvalAbort = new AbortController();
  const approvalSignal = AbortSignal.any([input.signal, approvalAbort.signal]);
  const pendingApprovals = new Set<Promise<unknown>>();
  let persistedError: ReturnType<typeof persistedExternalTurnError> | undefined;
  await beginExternalEnginePlanTurn(runtime, input.traceContext, input.events);
  try {
    const endPreparation = beginLocalTurnPreparation(input.traceContext, "engine_prepare");
    // 修复原因：adapter 已死时 prepareSession 会静默重启/恢复原生会话，但此前不发布 connecting，
    // 界面停在“正在等待模型…”。没有健康连接时沿用 engineConfigState 投影连接阶段。
    const reconnecting =
      runtime.externalEnginePort.isSessionConnected?.(runtime.sessionId) === false &&
      !runtime.shuttingDown;
    if (reconnecting)
      await publishExternalEngineConfigState(runtime, "connecting", input.traceContext);
    try {
      await runtime.externalEnginePort.prepareSession(
        externalEngineSessionInput(runtime, input.signal, input.traceContext),
      );
      endPreparation();
      if (reconnecting && !runtime.shuttingDown)
        await publishExternalEngineConfigState(runtime, "ready", input.traceContext);
    } catch (error) {
      endPreparation(input.signal.aborted ? "cancelled" : "failed");
      if (reconnecting && !runtime.shuttingDown && !input.signal.aborted)
        await publishExternalEngineConfigError(runtime, error, input.traceContext);
      throw error;
    }
    // 这里只知道 ACP prompt 交付时间；网关与供应商内部等待不能伪装成可独立观测的 HTTP 阶段。
    beginLocalTurnPreparation(input.traceContext, "request")();
    const requestApproval = async (request: ExternalEnginePermissionRequest) => {
      // 子会话请求回到父会话的待处理交互并标注来源；子会话的计划审批不改父会话模式。
      const origin = request.childNativeSessionId
        ? subagents.origin(request.childNativeSessionId)
        : undefined;
      const isPlanApproval = !request.childNativeSessionId && isExternalPlanApproval(request);
      await clearExternalEngineRetry(runtime, input.traceContext, input.events);
      if (isPlanApproval) markExternalEnginePlanReviewRequested(runtime);
      const modeOption = isPlanApproval ? nativePlanModeOption(runtime) : undefined;
      const recommended = isPlanApproval
        ? recommendedPlanOption(
            request,
            modeOption ? externalEnginePlanExitValue(runtime, modeOption) : undefined,
          )
        : undefined;
      const approvalRequest: PermissionBrokerRequest = {
        requestId: createToolCallId(),
        sessionId: runtime.sessionId,
        turnId: input.turnId,
        traceId: input.traceContext.traceId,
        toolCallId: request.toolCall.toolCallId as ReturnType<typeof createToolCallId>,
        toolName: isPlanApproval
          ? "ExitPlanMode"
          : String(request.toolCall.title ?? request.toolCall.kind ?? "External tool"),
        input: request.toolCall.rawInput ?? {},
        mode: runtime.config.mode ?? "build",
        ruleId: "external-engine",
        reason: isPlanApproval ? "计划已准备好，请确认是否开始执行" : "外部引擎请求执行工具",
        riskLevel: isPlanApproval ? "low" : "medium",
        ...(isPlanApproval
          ? {
              approvalMode: "user-once" as const,
              nativeOptions: nativePlanOptions(request, recommended),
            }
          : {}),
        requestedAt: new Date(),
        ...(origin ? { origin } : {}),
        optionsPolicy:
          !isPlanApproval && request.options.some((option) => option.kind === "allow_always")
            ? "session-always-allow"
            : "no-always-allow",
      };
      // 外部引擎绕过普通 tool executor，必须显式发布同一审批事实，V4 才能显示并收口原生卡片。
      await emit(SessionEventType.PermissionRequested, approvalRequest);
      let result: PermissionBrokerResult;
      try {
        // 发布请求期间可能已停止；不能把已取消的等待交给 broker。
        approvalSignal.throwIfAborted();
        result = await runtime.permissionBroker.requestPermission(approvalRequest, {
          signal: approvalSignal,
        });
      } catch (error) {
        // 取消的审批也必须收口，否则界面残留审批卡；ACP 侧回复 cancelled，不当作连接故障。
        await emit(SessionEventType.PermissionResolved, {
          requestId: approvalRequest.requestId,
          toolCallId: approvalRequest.toolCallId,
          decision: "deny",
          reason: PERMISSION_CANCELLED_REASON,
        });
        if (approvalSignal.aborted) return { outcome: "cancelled" as const };
        throw error;
      }
      await emit(SessionEventType.PermissionResolved, {
        requestId: approvalRequest.requestId,
        toolCallId: approvalRequest.toolCallId,
        decision: result.decision,
        reason: result.reason,
        modifiedInput: result.modifiedInput,
      });
      return isPlanApproval
        ? selectPlanApprovalOutcome(request, result, recommended)
        : selectExternalPermissionOption(
            request,
            result.decision,
            Boolean(result.sessionPermissionUpdates?.length || result.permissionUpdates?.length),
          );
    };
    const turnRun = runtime.externalEnginePort.runTurn({
      ...externalEngineSessionInput(runtime, input.signal, input.traceContext),
      prompt: blocks,
      requestPermission(request) {
        const pending = requestApproval(request);
        pendingApprovals.add(pending);
        void pending.finally(() => pendingApprovals.delete(pending)).catch(() => {});
        return pending;
      },
      onFailure: (notice) =>
        publishExternalEngineFailureNotice(runtime, notice, input.traceContext, input.events),
      onSubagent: (event) => subagents.onSubagent(event),
      onChildUpdate: (nativeSessionId, update) => subagents.onChildUpdate(nativeSessionId, update),
      onDiagnostic: (event, fields) => subagents.onDiagnostic(event, fields),
      async onUpdate(update) {
        if (
          ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(
            String(update.sessionUpdate),
          )
        )
          await clearExternalEngineRetry(runtime, input.traceContext, input.events);
        if (await writer.apply(update)) return;
        await publishExternalEngineSessionUpdate(runtime, update, input.traceContext, input.events);
      },
    });
    const completion = turnRun.then((result) => {
      if (!result.failure) return result;
      // typed 终态失败伴随 stopReason=end_turn 返回；按 session/prompt 请求失败走既有 turn 失败路径，
      // 连接保持健康、配置保持 ready，且不自动重发 prompt。
      markExternalEngineFailureTerminal(runtime, result.failure);
      throw new ExternalEngineConnectionError(
        {
          ...result.failure,
          method: "session/prompt",
          code: REQUEST_FAILURE_CODES.has(result.failure.code) ? result.failure.code : "provider",
        },
        result.failure.message,
      );
    });
    const result = await completion.catch(async (error: unknown) => {
      if (input.signal.aborted && !runtime.shuttingDown && runtime.config.externalSessionId) {
        // 已取消的 turn 不能再用其 signal 准备连接；复用原会话恢复入口，只恢复配置，不重发 prompt。
        await prepareExternalEngineSession(runtime, input.traceContext).catch(() => {
          // 准备入口已发布恢复失败；本轮仍按用户取消收尾。
        });
        throw error;
      }
      if (!runtime.shuttingDown) {
        if (isRequestFailure(error)) {
          // 请求失败保持原生配置可用，进程故障才进入重新连接状态。终态诊断随 TurnError 进入失败轮；
          // 这里只收口活动重试。
          markExternalEngineFailureTerminal(runtime, error.failure);
          await emit(SessionEventType.ExternalEngineFailureUpdated, {
            failure: error.failure,
            retrying: false,
          });
        } else await publishExternalEngineConfigError(runtime, error, input.traceContext);
      }
      throw error;
    });
    await writer.closeActiveText();
    state.modelResponse = writer.response;
    state.toolCallCount = writer.toolCallCount;
    state.tokenCount = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    if (result.usage)
      await emit(SessionEventType.ModelComplete, {
        content: state.modelResponse,
        stopReason: result.stopReason,
        toolCallCount: state.toolCallCount,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: state.tokenCount,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens,
        },
      });
    if (result.stopReason === "cancelled" || input.signal.aborted)
      throw new DOMException("External engine turn cancelled", "AbortError");
    await emit(SessionEventType.AssistantMessage, { content: state.modelResponse });
    if (handoff) await completeExternalEngineHandoff(runtime);
    await finishExternalEnginePlanTurn(runtime, input.traceContext, input.events);
    state.historyRoundCount = 1;
    return state;
  } catch (error) {
    // 用户停止不是失败；其余错误写入 assistant.error，冷恢复才能还原失败轮与行内错误行。
    if (!input.signal.aborted) persistedError = persistedExternalTurnError(error);
    throw error;
  } finally {
    approvalAbort.abort();
    // 取消的审批先发布 PermissionResolved，再由调用方发布 TurnError/TurnComplete，界面不残留审批卡。
    await Promise.allSettled(pendingApprovals);
    // 子会话先收尾：父轮的合成 Agent 行必须以子会话终态结束，而不是被当作未完成工具。
    await subagents.close(input.signal.aborted);
    await clearExternalEngineRetry(runtime, input.traceContext, input.events);
    await writer.finish({
      aborted: input.signal.aborted,
      ...(persistedError ? { error: persistedError } : {}),
    });
  }
}
