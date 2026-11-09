// 外部引擎进程池：每个 CLI 进程一个，负责 adapter 进程的“会话之外”的生命周期。
//
// - 未绑定备用受窗口 Host 0/1 许可约束，CLI 持有进程；warming 在 await 前独占预留。
//   pool 追踪未交付资源，索引只负责领用；取消/关闭等待迟到 spawn 与进程树结束。
//   ready hit 校验身份及已知入口，领用后进程归会话，未领用备用 10 分钟关闭。
// - 闲置连接关闭：各会话 port 登记自己的连接事实，池按节拍扫描，关闭不可见、无在途且闲置满窗口
//   （发过 prompt 的会话 15 分钟、草稿 10 分钟）的 adapter 进程；会话状态（ready、配置、
//   externalSessionId）不在此处，保持不变。可见事实由 Renderer 拥有，经 V4
//   `v4/conversation/visibility` 按连接上报，池只保存副本用作豁免。
//
// 规则见 docs/desktop/external-agent-engines-spec.md「外部引擎进程与异步准备」。
import { randomUUID } from "node:crypto";
import type { Logger } from "@zcode/contracts";
import { ExternalEngineConnectionError } from "@zcode/contracts";
import type { ExternalSessionEngine } from "@zcode/shared";
import type { AcpConnection } from "./connection.js";

export const EXTERNAL_ENGINE_SPARE_IDLE_MS = 10 * 60 * 1_000;
export const EXTERNAL_ENGINE_IDLE_CLOSE_MS = 15 * 60 * 1_000;
/**
 * 从未提交 prompt 的草稿连接闲置窗口。2026-11-08 用户决策：草稿 10 分钟关闭（扫描证据：
 * 草稿引擎会话约 3GB 私有提交永不关闭）；关闭后的再准备由 port 改走 session/new。
 */
export const EXTERNAL_ENGINE_DRAFT_IDLE_CLOSE_MS = 10 * 60 * 1_000;
export const EXTERNAL_ENGINE_IDLE_SWEEP_INTERVAL_MS = 60 * 1_000;
const LOG_MODULE = "adapters.external_engine.process_pool";

export interface ExternalEngineSpareKey {
  engine: ExternalSessionEngine;
  connectionProfileId: string;
  /** spawn cwd；领用要求一致，避免把别的目录启动的进程交给会话。 */
  cwd: string;
  /** 仅 adapter 内部使用，包含配置、凭据与启动环境的有效性代次。 */
  generation?: string;
}

export type ExternalEngineSpareMissReason = "none" | "budget" | "unhealthy" | "cwd" | "generation";

/** 会话 port 登记的连接事实；池只读取并请求释放，连接仍归 port 所有。 */
export interface ExternalEngineTrackedSession {
  engine: ExternalSessionEngine;
  /** 有健康连接时返回事实；无连接返回 undefined（不参与排名与关闭）。 */
  readConnection():
    | {
        busy: boolean;
        /**
         * 原生会话经 resume/load/fork 建立或已提交过 prompt。false = 草稿（session/new 或领用预建
         * 建立、从未 prompt）：闲置窗口更短，关闭后 port 的再准备改走 session/new。
         */
        resumable: boolean;
        lastUsedAt: number;
      }
    | undefined;
  /** 同步复查仍空闲后关闭 adapter 进程；返回是否已关闭。 */
  releaseIdle(): Promise<boolean>;
}

export interface ExternalEngineSpareClaim {
  connection: AcpConnection;
  refill(): void;
}

export interface ExternalEngineProcessPool {
  /** 第一个 await 前独占 warming/ready；取消关闭未交付连接。 */
  claimSpare(
    key: ExternalEngineSpareKey,
    signal?: AbortSignal,
  ): Promise<ExternalEngineSpareClaim | undefined>;
  /** 该（引擎，配置，cwd）新会话就绪后后台补位：spawn → initialize → session/new；失败只写日志。 */
  refillSpare(
    key: ExternalEngineSpareKey,
    launch: () => Promise<AcpConnection>,
    validate?: () => Promise<boolean>,
  ): void;
  /** Host 撤销只关闭未绑定备用；预留已归前台，不受撤销影响。 */
  revokeSpare(requestId: string): Promise<void>;
  trackSession(sessionId: string, session: ExternalEngineTrackedSession): void;
  untrackSession(sessionId: string): void;
  /**
   * 整体替换某个上报来源（V4 连接 ID）当前可见的会话；可见集合为各来源的并集，空集即删除该来源。
   * 可见会话不参与闲置关闭；从未上报的会话视为不可见。
   */
  setVisibleSessions(sourceId: string, sessionIds: readonly string[]): void;
  /** 闲置扫描（节拍自动调用；测试可直接调用）。 */
  sweepIdle(): Promise<void>;
  /** CLI 关闭：停止补位与扫描，关闭全部预建会话进程（含仍在准备的）。 */
  close(): Promise<void>;
}

export interface ExternalEngineProcessPoolOptions {
  logger?: Logger;
  budget?: {
    acquire(requestId: string, signal: AbortSignal): Promise<boolean>;
    release(requestId: string): Promise<void>;
  };
  now?: () => number;
  spareIdleMs?: number;
  idleCloseMs?: number;
  draftIdleCloseMs?: number;
  sweepIntervalMs?: number;
}

interface SpareEntry {
  requestId: string;
  launch: () => Promise<AcpConnection>;
  controller: AbortController;
  acquired: boolean;
  reserved?: boolean;
  discarded?: boolean;
  validate?: () => Promise<boolean>;
  releasing?: Promise<void>;
  key: ExternalEngineSpareKey;
  startedAt: number;
  readyAt?: number;
  connection?: AcpConnection;
  /** 并发关闭共享完成事实，不能在“已经开始 close”时提前释放 Host 许可。 */
  closing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
}

function spareMapKey(key: Pick<ExternalEngineSpareKey, "engine" | "connectionProfileId">): string {
  return JSON.stringify([key.engine, key.connectionProfileId]);
}

function failureCode(error: unknown): string {
  return error instanceof ExternalEngineConnectionError ? error.failure.code : "request";
}

export function createExternalEngineProcessPool(
  options: ExternalEngineProcessPoolOptions = {},
): ExternalEngineProcessPool {
  const now = options.now ?? Date.now;
  const spareIdleMs = options.spareIdleMs ?? EXTERNAL_ENGINE_SPARE_IDLE_MS;
  const idleCloseMs = options.idleCloseMs ?? EXTERNAL_ENGINE_IDLE_CLOSE_MS;
  const draftIdleCloseMs = options.draftIdleCloseMs ?? EXTERNAL_ENGINE_DRAFT_IDLE_CLOSE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? EXTERNAL_ENGINE_IDLE_SWEEP_INTERVAL_MS;
  const logger = options.logger;
  const spares = new Map<string, SpareEntry>();
  // 索引不是所有权：预留摘索引后，仍需追踪迟到 spawn，直到正式交付。
  const owned = new Set<SpareEntry>();
  const sessions = new Map<string, ExternalEngineTrackedSession>();
  /** 上报来源（V4 连接 ID）→ 该来源可见的会话；Renderer 事实的 CLI 侧副本，只用于闲置豁免。 */
  const visibleBySource = new Map<string, ReadonlySet<string>>();
  const isVisible = (sessionId: string) => {
    for (const visible of visibleBySource.values()) if (visible.has(sessionId)) return true;
    return false;
  };
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  let closed = false;

  const fields = (key: ExternalEngineSpareKey) => ({
    module: LOG_MODULE,
    engine: key.engine,
    connectionProfileId: key.connectionProfileId,
  });

  const discardSpare = async (entry: SpareEntry): Promise<void> => {
    entry.discarded = true;
    entry.controller.abort();
    clearTimeout(entry.timer);
    const mapKey = spareMapKey(entry.key);
    if (spares.get(mapKey) === entry) spares.delete(mapKey);
    const connection = entry.connection;
    if (!connection) return;
    entry.closing ??= connection.close(true);
    const closing = entry.closing;
    try {
      await closing;
    } catch (error) {
      // 失败不是退出事实；保留 owned 和许可，允许后续撤销/关闭重试同一资源。
      if (entry.closing === closing) entry.closing = undefined;
      throw error;
    }
  };

  const reportCloseFailure = () =>
    logger?.warn("External engine spare exit unconfirmed", {
      module: LOG_MODULE,
      event: "external_engine.spare.close_failed",
    });

  const releaseBudget = (entry: SpareEntry): Promise<void> => {
    entry.releasing ??=
      options.budget?.release(entry.requestId).catch(() => {}) ?? Promise.resolve();
    // 释放是幂等通知语义：Host 未收到时保守保留许可；不能让丢失的 ACK 卡住前台或关闭。
    return Promise.resolve();
  };
  const retire = async (entry: SpareEntry) => {
    await discardSpare(entry);
    await entry.task;
    // launch 可能在第一次 discard 之后才交付；后台失败日志不等于退出，必须再次确认同一资源。
    await discardSpare(entry);
    await releaseBudget(entry);
    owned.delete(entry);
  };

  const armExpiry = (entry: SpareEntry) => {
    entry.timer = setTimeout(() => {
      if (spares.get(spareMapKey(entry.key)) !== entry) return;
      logger?.info("External engine spare expired", {
        ...fields(entry.key),
        event: "external_engine.spare.expired",
        idleMs: now() - (entry.readyAt ?? entry.startedAt),
      });
      void retire(entry).catch(reportCloseFailure);
    }, spareIdleMs);
    entry.timer.unref?.();
  };

  const stopSweepIfIdle = () => {
    if (sessions.size > 0 && !closed) return;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
  };

  const sweepIdle = (): Promise<void> => {
    // 同一时刻只跑一轮扫描；释放是异步的，上一轮未完成时不能用旧事实重复关闭。
    sweeping ??= (async () => {
      const observedAt = now();
      // 2026-11-08 起只豁免可见会话（取代“最近 3 个可恢复会话”，该名额按每个 CLI 计，生产上
      // 5 天 0 次关闭）；草稿也参与关闭，窗口更短。在途操作（含运行中 prompt 的待处理权限）不关。
      const candidates = [...sessions.entries()].map(([sessionId, session]) => ({
        sessionId,
        session,
        facts: session.readConnection(),
      }));
      for (const item of candidates) {
        if (closed) break;
        const facts = item.facts;
        if (!facts || facts.busy || isVisible(item.sessionId)) continue;
        const idleMs = observedAt - facts.lastUsedAt;
        if (idleMs < (facts.resumable ? idleCloseMs : draftIdleCloseMs)) continue;
        if (sessions.get(item.sessionId) !== item.session) continue;
        // 释放是异步的；await 前同一会话可能刚变为可见，按最新可见事实再确认一次。
        if (isVisible(item.sessionId)) continue;
        if (await item.session.releaseIdle())
          logger?.info("External engine idle adapter closed", {
            module: LOG_MODULE,
            event: "external_engine.idle_close",
            engine: item.session.engine,
            sessionId: item.sessionId,
            idleMs,
            kind: facts.resumable ? "prompted" : "draft",
          });
      }
    })().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };

  const pool: ExternalEngineProcessPool = {
    async claimSpare(key, signal) {
      const mapKey = spareMapKey(key);
      const entry = spares.get(mapKey);
      let reason: ExternalEngineSpareMissReason | undefined;
      if (!entry || closed || signal?.aborted) reason = "none";
      else if (!entry.acquired) reason = "budget";
      else if (entry.key.cwd !== key.cwd) reason = "cwd";
      else if (entry.key.generation !== key.generation) reason = "generation";
      else if (entry.connection && !entry.connection.healthy) reason = "unhealthy";
      if (reason || !entry) {
        if (entry && reason !== "none" && reason !== "budget")
          void retire(entry).catch(reportCloseFailure);
        logger?.info("External engine spare missed", {
          ...fields(key),
          event: "external_engine.spare.miss",
          reason: reason ?? "none",
        });
        return undefined;
      }
      // 必须先同步预留；否则两个新会话会领到同一个原生 session ID。
      entry.reserved = true;
      spares.delete(mapKey);
      clearTimeout(entry.timer);
      logger?.info("External engine spare reserved", {
        ...fields(key),
        event: "external_engine.spare.reserved",
        warming: entry.readyAt === undefined,
      });
      const abort = () => {
        void discardSpare(entry).catch(reportCloseFailure);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        void releaseBudget(entry);
        await entry.task;
        if (
          closed ||
          signal?.aborted ||
          entry.discarded ||
          !entry.connection?.healthy ||
          (entry.validate && !(await entry.validate()))
        ) {
          await retire(entry);
          return undefined;
        }
        if (closed || signal?.aborted || entry.discarded) {
          await retire(entry);
          return undefined;
        }
        owned.delete(entry);
        logger?.info("External engine spare claimed", {
          ...fields(key),
          event: "external_engine.spare.claimed",
          ageMs: now() - (entry.readyAt ?? entry.startedAt),
        });
        return {
          connection: entry.connection,
          refill: () => pool.refillSpare(entry.key, entry.launch, entry.validate),
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    refillSpare(key, launch, validate) {
      if (closed) return;
      const mapKey = spareMapKey(key);
      const existing = spares.get(mapKey);
      if (existing) {
        if (
          existing.key.cwd === key.cwd &&
          existing.key.generation === key.generation &&
          (!existing.connection || existing.connection.healthy)
        )
          return;
        void retire(existing).catch(reportCloseFailure);
      }
      const entry: SpareEntry = {
        key,
        launch,
        acquired: !options.budget,
        startedAt: now(),
        requestId: randomUUID(),
        controller: new AbortController(),
        ...(validate ? { validate } : {}),
      };
      spares.set(mapKey, entry);
      owned.add(entry);
      const isCurrent = () => !closed && !entry.discarded && owned.has(entry);
      entry.task = (async () => {
        try {
          if (
            options.budget &&
            !(await options.budget.acquire(entry.requestId, entry.controller.signal))
          ) {
            await discardSpare(entry);
            return;
          }
          entry.acquired = true;
          if (!isCurrent()) return;
          entry.connection = await launch();
          if (!isCurrent()) throw new Error("External engine spare superseded");
          await entry.connection.prebuild(key.engine, key.cwd);
          if (!isCurrent()) throw new Error("External engine spare superseded");
          entry.readyAt = now();
          if (!entry.reserved) armExpiry(entry);
          logger?.info("External engine spare ready", {
            ...fields(key),
            event: "external_engine.spare.ready",
            durationMs: entry.readyAt - entry.startedAt,
          });
        } catch (error) {
          if (isCurrent())
            logger?.warn("External engine spare failed", {
              ...fields(key),
              event: "external_engine.spare.failed",
              code: failureCode(error),
            });
          await discardSpare(entry);
        } finally {
          if (entry.discarded || closed) {
            await discardSpare(entry);
            await releaseBudget(entry);
            owned.delete(entry);
          }
        }
      })().catch(reportCloseFailure);
    },
    async revokeSpare(requestId) {
      const entry = [...owned].find((item) => item.requestId === requestId);
      if (entry && !entry.reserved) await retire(entry);
    },
    trackSession(sessionId, session) {
      if (closed) return;
      sessions.set(sessionId, session);
      if (!sweepTimer) {
        sweepTimer = setInterval(() => void sweepIdle(), sweepIntervalMs);
        sweepTimer.unref?.();
      }
    },
    untrackSession(sessionId) {
      sessions.delete(sessionId);
      stopSweepIfIdle();
    },
    setVisibleSessions(sourceId, sessionIds) {
      if (sessionIds.length === 0) visibleBySource.delete(sourceId);
      else visibleBySource.set(sourceId, new Set(sessionIds));
    },
    sweepIdle,
    async close() {
      closed = true;
      visibleBySource.clear();
      stopSweepIfIdle();
      const entries = [...owned];
      await Promise.all(
        entries.map(async (entry) => {
          await retire(entry);
        }),
      );
    },
  };
  return pool;
}
