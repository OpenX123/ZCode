// 原生 prompt turn 运行器。
//
// Core admission 只负责接受输入并建立 session-scoped reservation；本文件不再拥有
// activeAbortController，也不等待 projection commit。这样 TurnStarted 之后的任意 Core
// starting/active 状态都会继续挡住同一 session 的第二次 start。
import { type TurnBackgroundAttribution, type TurnInputIntentMetadata } from "@zcode/contracts";
import type { TurnAttachment } from "@zcode/core";
import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type { SendInputOptions, SendInputResult } from "../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../session-execution/index.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

export interface StartPromptTurnParamsBase {
  content: string;
  /** v4 锚点：inputId=queryId=commandId（权威数据 sourceCommandId 对账）。 */
  inputId: string;
  inputPresentation?: SendInputOptions["inputPresentation"];
  /** 附件命令面：AttachmentRef 已在 handler 层映射为 core TurnAttachment。 */
  attachments?: TurnAttachment[];
  browserAmbientContext?: SendInputOptions["browserAmbientContext"];
  intent?: TurnInputIntentMetadata;
  /** 标准 Selection 的单次执行约束；不会改写 Session Selection。 */
  modelExecution?: SendInputOptions["modelExecution"];
  sharedContextRefs?: SendInputOptions["sharedContextRefs"];
  toolDisallowlist?: readonly string[];
  /** 当前输入必须保留为未来独立 turn，不能因 admission 瞬间转为空闲而直接启动。 */
  requireQueue?: boolean;
  /** sendQueuedNow 已持有 Core promotion lease，要求这次 admission 只能占用空闲位。 */
  requireIdle?: boolean;
  /** Bot 入站 turn 的稳定回推地址；仅在本 turn 内暴露给 CronCreate。 */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type StartPromptTurnParams = StartPromptTurnParamsBase & TurnBackgroundAttribution;

export interface PromptTurnStartResult {
  /** Core admission 已完成；不等待 TurnStarted 或 projection commit。 */
  turnStarted: Promise<void>;
  /** Core 真实完成 promise，仅供生命周期清理使用，不属于 ACK 边界。 */
  completion?: Promise<unknown>;
  admission: SendInputResult;
  /** 兼容旧调用方；初始 ACK 不再依赖 messageId。 */
  messageId?: string;
}

export class V4PromptRejectedError extends Error {
  readonly turnStartUncertain = false;

  constructor(
    readonly reasonCode: "restoreWarning" | "activePrompt" | "modelUnavailable",
    message: string,
  ) {
    super(message);
    this.name = "V4PromptRejectedError";
  }
}

/** 旧 queue promotion 兼容谓词：新的 Core admission 不再产生 projection authority 不确定态。 */
export function isPromptTurnStartUncertainFailure(_error: unknown): boolean {
  return false;
}

/**
 * 只执行 prompt 的模型准入检查，不接纳输入或修改 turn 生命周期。
 * edit/retry 在提交 branch cut 前复用此入口，避免破坏性操作与普通发送使用两套目录规则。
 */
export async function preflightPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<void> {
  // ACP 会话沿用输入准入与持久化，但不依赖内置 Provider Registry。
  if (record.app.runtime?.getSessionEngine?.() && record.app.runtime.getSessionEngine() !== "zcode")
    return;
  // 排队输入的 execution 只在提升边界应用，准入阶段一律按普通 Selection 预检，供卡失效后提升。
  const usesExecutionSelection =
    params.modelExecution?.selectionScope === "execution" && !params.requireQueue;
  if (!usesExecutionSelection && record.restoreWarning) {
    // app 重启后冷恢复可能跑在 provider registry 推送
    // 之前，record 创建时判「模型不可解析」挂上告警；registry 随后到达时 runtime
    // 早已可服务，但这个一次性标志没人回来清——发送被永久拒（用户只能手动切模型
    // 解锁）。闸前经宿主能力重评：已有可用目标则清除过期告警，随后仍由
    // ensureModelReady 校验当前选择；不能在这里兜底换模型或清空持久选择。
    // 仍无可用模型/宿主不支持 → 维持拒绝。
    if (host.hasUsableRuntimeModelTarget?.(record) === true) {
      host.logger?.info?.("v4 restoreWarning cleared by model catalog recovery", {
        sessionId: record.app.sessionId,
        warningType: record.restoreWarning.type,
      });
      record.restoreWarning = undefined;
    }
  }
  if (!usesExecutionSelection && record.restoreWarning) {
    throw new V4PromptRejectedError("restoreWarning", record.restoreWarning.message);
  }
  if (!usesExecutionSelection) {
    await host.ensureModelReady?.(record);
  }
  const requestedSelection = params.intent?.modelSelection;
  const availableModels =
    typeof record.app.listModels === "function" ? record.app.listModels() : undefined;
  const isSelectionAvailable = (selection: typeof requestedSelection): boolean =>
    selection !== undefined &&
    availableModels?.some(
      (model) =>
        model.ref.providerId === selection.providerId && model.ref.modelId === selection.modelId,
    ) === true;
  if (requestedSelection && availableModels && !isSelectionAvailable(requestedSelection)) {
    // 执行前严格检查原选择，旧官方模型缺失时不能静默换为其他 Provider。
    throw new V4PromptRejectedError(
      "modelUnavailable",
      `Provider Registry 中不存在 Model: ${requestedSelection.providerId}/${requestedSelection.modelId}`,
    );
  }
}

/**
 * 入口只做模型/持久化前置校验，然后调用 app -> Core admission。Core 返回 started 时，
 * 后台生命周期等待 completion 清理 turn 归因和广播状态；RPC 本身立即返回 admission receipt。
 */
export async function startPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  await preflightPromptTurn(host, record, params);
  return startPromptTurnAfterPreflight(host, record, params);
}

/**
 * destructive edit/retry 已在 branch cut 前完成同一份准入检查；提交后必须直接消费该结果。
 * Bug 根因：再次读取可变 Registry 会在历史已截断后拒绝 replacement input。
 */
export async function startPreflightedPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  return startPromptTurnAfterPreflight(host, record, params);
}

async function startPromptTurnAfterPreflight(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  if (record.persistence === "deferred") record.persistence = "immediate";

  const previousAutomationId = record.activeAutomationId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolveTurnAutomationId(params);
  const turnToolDisallowlist = buildTurnToolDisallowlist(params, activeAutomationId);
  if (activeAutomationId) record.activeAutomationId = activeAutomationId;
  record.activeBotDeliveryTarget = params.botDeliveryTarget;

  let admission: SendInputResult;
  try {
    admission = await record.app.sendInput(
      {
        text: params.content,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      {
        // Bootstrap controller 曾经被当成 Core busy 真相，并由 projection watchdog
        // 清理它；现在 Core admission 自己持有 reservation，Stop 也直接调用 Core execution。
        delivery: "start_turn",
        ...(params.intent?.requestedDelivery === "guide"
          ? { queueDelivery: "guide" as const }
          : {}),
        ...(params.browserAmbientContext
          ? { browserAmbientContext: params.browserAmbientContext }
          : {}),
        inputId: params.inputId,
        ...(params.inputPresentation ? { inputPresentation: params.inputPresentation } : {}),
        ...turnBackgroundAttributionOf({
          automationId: activeAutomationId,
          offPeakTaskId: params.offPeakTaskId,
          offPeakRunType: params.offPeakRunType,
        }),
        intent: params.intent,
        ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
        ...(params.sharedContextRefs ? { sharedContextRefs: params.sharedContextRefs } : {}),
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
        ...(params.requireQueue ? { requireQueue: true } : {}),
        ...(params.requireIdle ? { requireIdle: true } : {}),
        queryId: params.inputId as SendInputOptions["queryId"],
      },
    );
  } catch (error) {
    clearPromptRecordState(record, previousAutomationId, previousBotDeliveryTarget);
    await host.afterLegacyStateMutation?.(record, "prompt_failed");
    throw error;
  }

  if (admission.kind === "rejected") {
    clearPromptRecordState(record, previousAutomationId, previousBotDeliveryTarget);
    throw new V4PromptRejectedError(
      "activePrompt",
      `Core prompt admission rejected: ${admission.reason}`,
    );
  }

  if (admission.kind === "queued") {
    clearPromptRecordState(record, previousAutomationId, previousBotDeliveryTarget);
    return { admission, turnStarted: Promise.resolve() };
  }

  const completion = runWithSessionResidencyFinalization(record, async () => {
    let mutationReason = "prompt_completed";
    try {
      await admission.completion;
    } catch (error) {
      mutationReason = "prompt_failed";
      host.logger?.warn?.("v4 background turn failed", {
        error: error instanceof Error ? error.message : String(error),
        inputId: params.inputId,
        sessionId: record.app.sessionId,
      });
    } finally {
      clearPromptRecordState(record, previousAutomationId, previousBotDeliveryTarget);
      await host.afterLegacyStateMutation?.(record, mutationReason);
    }
  });
  void completion.catch(() => undefined);
  host.logger?.info?.("v4 prompt admitted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
  });
  return { admission, completion, turnStarted: Promise.resolve() };
}

function clearPromptRecordState(
  record: V4SessionRecordView,
  previousAutomationId: string | undefined,
  previousBotDeliveryTarget: V4SessionRecordView["activeBotDeliveryTarget"],
): void {
  record.activeAutomationId = previousAutomationId;
  record.activeBotDeliveryTarget = previousBotDeliveryTarget;
}

export function buildTurnToolDisallowlist(
  params: Pick<StartPromptTurnParams, "automationId" | "toolDisallowlist">,
  activeAutomationId = params.automationId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDisallowlist ?? []);
  if (activeAutomationId) {
    // automation 派发漏传身份时，后续 model step 会重新暴露 Cron 写工具。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

export function resolveTurnAutomationId(
  params: Pick<StartPromptTurnParams, "automationId" | "inputId">,
): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(AUTOMATION_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > AUTOMATION_INPUT_ID_PREFIX.length ? automationId : undefined;
}

export function turnBackgroundAttributionOf(params: {
  automationId?: string;
  offPeakTaskId?: string;
  offPeakRunType?: "init" | "resume";
}): TurnBackgroundAttribution {
  if (params.automationId) return { automationId: params.automationId };
  if (params.offPeakTaskId) {
    return {
      offPeakTaskId: params.offPeakTaskId,
      ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
    };
  }
  return {};
}

const AUTOMATION_INPUT_ID_PREFIX = "automation-";
const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
