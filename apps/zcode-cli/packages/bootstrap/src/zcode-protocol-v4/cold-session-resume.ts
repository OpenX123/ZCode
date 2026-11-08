// 冷恢复协调器：订阅落在「不在内存注册表、但可能已持久化」的会话时
// （CLI 重启后打开历史会话），经宿主钩子把 record 拉起来，再回到既有
// gateway READY hydration 路径。从 v4-gateway 拆出（单一职责 + max-lines）。
//
// 语义要点：
// - 这里只保留既有 runtime activation 单飞；完整 READY 水位由 gateway 负责；
// - 错误分型（项目规范：不靠错误文本分流）：
//   fault.subscribe.sessionNotFound（store 里也没有 / 宿主不支持恢复）
//   vs fault.subscribe.resumeFailed（恢复中途失败，保留原始 cause）。
//   message 附带 reasonCode——renderer 订阅错误块直显 lastError，无需 UI 改动即透出。

import type { MessageWithParts } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";

/** 恢复过程中的进度回调（不改变恢复结果）。 */
export interface ColdSessionResumeHooks {
  /**
   * 会话 record 已入册（runtime.resume 之前，外部引擎握手之前）。只读 journal 的查询据此不必
   * 等待整个恢复（含外部引擎握手，生产 14.2s）完成。
   */
  onRecordRegistered?: () => void;
}

export type ColdSessionResumeOutcome =
  | {
      status: "resumed";
      persistedMessages?: MessageWithParts[];
      disposeOnFailure?: () => Promise<void>;
    }
  | { status: "notFound" };

/** 协调器需要的宿主能力窄面（与 V4GatewayHost 同形，避免循环 import）。 */
export interface ColdSessionResumeHost {
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
    hooks?: ColdSessionResumeHooks,
  ): Promise<ColdSessionResumeOutcome>;
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

/** 订阅不可用会话的结构化错误（reasonCode 见文件头）。 */
export class V4SubscribeSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reasonCode: "fault.subscribe.sessionNotFound" | "fault.subscribe.resumeFailed",
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${reasonCode})`, options);
    this.name = "V4SubscribeSessionUnavailableError";
  }
}

export class ColdSessionResumeCoordinator {
  /** sessionId → 进行中的 runtime activation；settle 后立即释放。 */
  private readonly flights = new Map<string, Promise<MessageWithParts[] | undefined>>();

  constructor(private readonly host: ColdSessionResumeHost) {}

  ensureResumed(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
    onActivated?: (outcome: Extract<ColdSessionResumeOutcome, { status: "resumed" }>) => void,
    hooks?: ColdSessionResumeHooks,
  ): Promise<MessageWithParts[] | undefined> {
    const inFlight = this.flights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold resume joined existing flight session=${sessionId}`);
      return inFlight;
    }
    this.host.onDebug?.(`cold resume flight created session=${sessionId}`);
    const flight = this.resume(
      sessionId,
      resumeThoughtLevel,
      workspace,
      additionalDirectories,
      persistedMessages,
      onActivated,
      hooks,
    ).finally(() => {
      this.flights.delete(sessionId);
      this.host.onDebug?.(`cold resume flight cleared session=${sessionId}`);
    });
    this.flights.set(sessionId, flight);
    return flight;
  }

  clear(): void {
    this.flights.clear();
  }

  private async resume(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
    onActivated?: (outcome: Extract<ColdSessionResumeOutcome, { status: "resumed" }>) => void,
    hooks?: ColdSessionResumeHooks,
  ): Promise<MessageWithParts[] | undefined> {
    const resume = this.host.resumePersistedSession;
    if (!resume) {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active: ${sessionId}`,
      );
    }
    let outcome: ColdSessionResumeOutcome;
    try {
      // 只有提供了进度钩子（history-first 打开）才传第 6 个参数，其余入口保持原调用形状。
      outcome = await resume.call(
        this.host,
        sessionId,
        resumeThoughtLevel,
        workspace,
        additionalDirectories,
        persistedMessages,
        ...(hooks ? [hooks] : []),
      );
    } catch (error) {
      this.host.onError?.("v4.subscribe.resume", error, {
        phase: "resumePersistedSession",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to resume persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    onActivated?.(outcome);
    return outcome.persistedMessages;
  }
}
