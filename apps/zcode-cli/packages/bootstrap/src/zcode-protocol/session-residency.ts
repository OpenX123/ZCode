// Session 常驻池的真实事实适配与去激活执行面。

import type { SessionId } from "@zcode/contracts";
import type {
  SessionDeactivationDecision,
  SessionResidentPoolHost,
} from "./session-resident-pool.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

export {
  acquireSessionResidencyFinalization,
  runWithSessionResidencyFinalization,
  type SessionResidencyFinalizationOwner,
} from "../session-execution/index.js";

/**
 * 协议 server 的会话 record 注册表（唯一注册表，常驻池与所有创建 / 恢复 / 分叉 / 关闭 / 去激活路径共用）。
 * record 数变化时同步回调，供 `process/residentSessions` 通知 Host：Host 回收工作区 CLI 需要“0 个常驻
 * 会话”的事实，此前 CLI 不暴露，Host 只能失败关闭地近似（承载过会话的 CLI 本代永不回收）。
 * 同一 ID 的替换不改变数量，不回调。
 */
export class ResidentSessionRegistry<Record> extends Map<string, Record> {
  constructor(private readonly onSizeChange: (size: number) => void) {
    super();
  }

  override set(sessionId: string, record: Record): this {
    const before = this.size;
    super.set(sessionId, record);
    if (this.size !== before) this.onSizeChange(this.size);
    return this;
  }

  override delete(sessionId: string): boolean {
    const deleted = super.delete(sessionId);
    if (deleted) this.onSizeChange(this.size);
    return deleted;
  }

  override clear(): void {
    const before = this.size;
    super.clear();
    if (before !== 0) this.onSizeChange(0);
  }
}

/**
 * 只释放 resident runtime，不删除任何持久 session/task 事实。
 *
 * 若先 await app.close，再从 registry 摘除，新的 cold subscribe 会在 await
 * 窗口命中一个已进入 shutdown 的旧 runtime；若先删 record 但不设置 pool gate，新旧 app
 * 又会并发碰同一 session 资源。因此同步摘除与异步 close 必须由 pool 的 in-flight gate
 * 组合成一个生命周期事务。
 */
export async function deactivateSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  const record = context.sessions.get(sessionId);
  if (!record) return;
  // CommandInbox pin 的拒绝曾发生在 unsubscribe 之后，异常会留下仍在 registry
  // 但收不到 runtime event 的半清 record。所有可预检拒绝必须早于第一个副作用。
  context.v4Gateway?.assertSessionRuntimeDeactivatable(sessionId);
  record.unsubscribe?.();
  context.v4Gateway?.deactivateSession(sessionId);
  context.sessions.delete(sessionId);
  await record.app.close?.();
  // 去激活后内存 event store 必须与“从未加载”等价。
  await record.eventStore.deleteSession(sessionId as SessionId);
}

export function createSessionResidentPoolHost(
  context: ZCodeProtocolAgentServerContext,
): SessionResidentPoolHost {
  return {
    deactivate: (sessionId) => deactivateSessionRecord(context, sessionId),
    listSessionIds: () => [...context.sessions.keys()],
    readResidencyFacts: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        hasPendingInteractions: context.v4Interactions.hasPendingForSession(sessionId),
        hasQueuedCommands: context.v4Gateway?.hasResidencyBlockingCommands(sessionId) ?? false,
        hasLegacySubscriber: record.legacyStreamSubscribed === true,
        // active/queue 与 registry background task 不能覆盖 title、MCP、memory
        // 等 detached work；统一查询由 runtime 维护，协议 finalization 只补协议所有权。
        hasResidencyBlockingWork:
          record.activeAbortController !== undefined ||
          (record.residencyFinalizationCount ?? 0) > 0 ||
          record.app.runtime.hasResidencyBlockingWork(),
        hasSubscribers: context.v4Gateway?.hasConversationSubscribers(sessionId) ?? false,
        lastActivityAt: record.updatedAt,
        persisted: record.persistence === "immediate",
      };
    },
    onDeactivated: (sessionId, decision) => {
      context.logger?.info("Session resident runtime deactivated", {
        ...deactivationLogContext(decision),
        event: "zcode_protocol.session.resident_deactivated",
        sessionId,
      });
    },
    onError: (sessionId, error, decision) => {
      context.logger?.warn("Session resident deactivation failed", {
        ...deactivationLogContext(decision),
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.resident_deactivation_failed",
        sessionId,
      });
    },
  };
}

function deactivationLogContext(
  decision: SessionDeactivationDecision,
): Record<string, number | string> {
  return {
    highWaterCount: decision.highWaterCount,
    idleMs: decision.idleMs,
    idleTimeoutMs: decision.idleTimeoutMs,
    reason: decision.reason,
    residentCountBefore: decision.residentCountBefore,
    targetCount: decision.targetCount,
  };
}
