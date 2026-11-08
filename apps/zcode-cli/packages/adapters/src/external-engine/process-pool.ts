// 外部引擎进程池：每个 CLI 进程一个，负责 adapter 进程的“会话之外”的生命周期。
//
// - 预建会话（spare）：每个（引擎，连接配置 ID）至多一个已完成 initialize（与 providers/set）、
//   在其 cwd 的 session/new 与新会话默认配置、但从未提交 prompt 的 adapter；新会话 cwd 一致时同步
//   领用（不一致按未命中，补位时替换），新会话就绪后后台补位，闲置 10 分钟关闭。
// - 闲置连接关闭：各会话 port 登记自己的连接事实，池按节拍扫描，关闭空闲 15 分钟且不在最近
//   3 个可恢复会话内的 adapter 进程；会话状态（ready、配置、externalSessionId）不在此处，保持不变。
//
// 规则见 docs/desktop/external-agent-engines-spec.md「外部引擎进程与异步准备」。
import type { Logger } from "@zcode/contracts";
import { ExternalEngineConnectionError } from "@zcode/contracts";
import type { ExternalSessionEngine } from "@zcode/shared";
import type { AcpConnection } from "./connection.js";

export const EXTERNAL_ENGINE_SPARE_IDLE_MS = 10 * 60 * 1_000;
export const EXTERNAL_ENGINE_IDLE_CLOSE_MS = 15 * 60 * 1_000;
export const EXTERNAL_ENGINE_IDLE_EXEMPT_COUNT = 3;
export const EXTERNAL_ENGINE_IDLE_SWEEP_INTERVAL_MS = 60 * 1_000;
const LOG_MODULE = "adapters.external_engine.process_pool";

export interface ExternalEngineSpareKey {
  engine: ExternalSessionEngine;
  connectionProfileId: string;
  /** spawn cwd；领用要求一致，避免把别的目录启动的进程交给会话。 */
  cwd: string;
}

export type ExternalEngineSpareMissReason = "none" | "warming" | "unhealthy" | "cwd";

/** 会话 port 登记的连接事实；池只读取并请求释放，连接仍归 port 所有。 */
export interface ExternalEngineTrackedSession {
  engine: ExternalSessionEngine;
  /** 有健康连接时返回事实；无连接返回 undefined（不参与排名与关闭）。 */
  readConnection():
    | {
        busy: boolean;
        /** 原生会话经 resume/load 建立或已提交过 prompt；从未 prompt 的新会话不一定能 resume。 */
        resumable: boolean;
        lastUsedAt: number;
      }
    | undefined;
  /** 同步复查仍空闲后关闭 adapter 进程；返回是否已关闭。 */
  releaseIdle(): Promise<boolean>;
}

export interface ExternalEngineProcessPool {
  /** 新会话握手前同步领用预建会话；未命中返回 undefined，由调用方冷启动。 */
  claimSpare(key: ExternalEngineSpareKey): AcpConnection | undefined;
  /** 该（引擎，配置，cwd）新会话就绪后后台补位：spawn → initialize → session/new；失败只写日志。 */
  refillSpare(key: ExternalEngineSpareKey, launch: () => Promise<AcpConnection>): void;
  trackSession(sessionId: string, session: ExternalEngineTrackedSession): void;
  untrackSession(sessionId: string): void;
  /** 闲置扫描（节拍自动调用；测试可直接调用）。 */
  sweepIdle(): Promise<void>;
  /** CLI 关闭：停止补位与扫描，关闭全部预建会话进程（含仍在准备的）。 */
  close(): Promise<void>;
}

export interface ExternalEngineProcessPoolOptions {
  logger?: Logger;
  now?: () => number;
  spareIdleMs?: number;
  idleCloseMs?: number;
  idleExemptCount?: number;
  sweepIntervalMs?: number;
}

interface SpareEntry {
  key: ExternalEngineSpareKey;
  startedAt: number;
  readyAt?: number;
  connection?: AcpConnection;
  /** 已关闭的连接；关闭与启动任务的 catch 可能都会走到，避免重复结束进程树。 */
  closedConnection?: AcpConnection;
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
  const exemptCount = options.idleExemptCount ?? EXTERNAL_ENGINE_IDLE_EXEMPT_COUNT;
  const sweepIntervalMs = options.sweepIntervalMs ?? EXTERNAL_ENGINE_IDLE_SWEEP_INTERVAL_MS;
  const logger = options.logger;
  const spares = new Map<string, SpareEntry>();
  const sessions = new Map<string, ExternalEngineTrackedSession>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  let closed = false;

  const fields = (key: ExternalEngineSpareKey) => ({
    module: LOG_MODULE,
    engine: key.engine,
    connectionProfileId: key.connectionProfileId,
  });

  const discardSpare = async (entry: SpareEntry): Promise<void> => {
    clearTimeout(entry.timer);
    const mapKey = spareMapKey(entry.key);
    if (spares.get(mapKey) === entry) spares.delete(mapKey);
    const connection = entry.connection;
    if (!connection || entry.closedConnection === connection) return;
    entry.closedConnection = connection;
    await connection.close();
  };

  const armExpiry = (entry: SpareEntry) => {
    entry.timer = setTimeout(() => {
      if (spares.get(spareMapKey(entry.key)) !== entry) return;
      logger?.info("External engine spare expired", {
        ...fields(entry.key),
        event: "external_engine.spare.expired",
        idleMs: now() - (entry.readyAt ?? entry.startedAt),
      });
      void discardSpare(entry);
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
      const connected = [...sessions.entries()]
        .map(([sessionId, session]) => ({ sessionId, session, facts: session.readConnection() }))
        .filter(
          (item): item is typeof item & { facts: NonNullable<typeof item.facts> } =>
            item.facts?.resumable === true,
        )
        .map((item) => ({
          ...item,
          lastUsedAt: item.facts.busy ? observedAt : item.facts.lastUsedAt,
        }))
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
      for (const item of connected.slice(exemptCount)) {
        if (closed) break;
        if (item.facts.busy || observedAt - item.lastUsedAt < idleCloseMs) continue;
        if (sessions.get(item.sessionId) !== item.session) continue;
        const idleMs = observedAt - item.lastUsedAt;
        if (await item.session.releaseIdle())
          logger?.info("External engine idle adapter closed", {
            module: LOG_MODULE,
            event: "external_engine.idle_close",
            engine: item.session.engine,
            sessionId: item.sessionId,
            idleMs,
          });
      }
    })().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };

  return {
    claimSpare(key) {
      const mapKey = spareMapKey(key);
      const entry = spares.get(mapKey);
      let reason: ExternalEngineSpareMissReason | undefined;
      if (!entry) reason = "none";
      else if (!entry.readyAt || !entry.connection) reason = "warming";
      else if (entry.key.cwd !== key.cwd) reason = "cwd";
      else if (!entry.connection.healthy) {
        reason = "unhealthy";
        void discardSpare(entry);
      }
      if (reason || !entry?.connection) {
        logger?.info("External engine spare missed", {
          ...fields(key),
          event: "external_engine.spare.miss",
          reason: reason ?? "none",
        });
        return undefined;
      }
      clearTimeout(entry.timer);
      spares.delete(mapKey);
      logger?.info("External engine spare claimed", {
        ...fields(key),
        event: "external_engine.spare.claimed",
        ageMs: now() - (entry.readyAt ?? entry.startedAt),
      });
      return entry.connection;
    },
    refillSpare(key, launch) {
      if (closed) return;
      const mapKey = spareMapKey(key);
      const existing = spares.get(mapKey);
      if (existing) {
        if (!existing.readyAt) return;
        if (existing.key.cwd === key.cwd && existing.connection?.healthy) return;
        void discardSpare(existing);
      }
      const entry: SpareEntry = { key, startedAt: now() };
      spares.set(mapKey, entry);
      const isCurrent = () => !closed && spares.get(mapKey) === entry;
      entry.task = (async () => {
        try {
          entry.connection = await launch();
          if (!isCurrent()) throw new Error("External engine spare superseded");
          // 预建到 session/new（含 Claude Auto 默认）：Claude 的 session/new 要拉起官方 CLI（本机约 1.5s），
          // 只预热到 initialize 时命中仍需约 1.76s。连接先登记再预建，关闭池时可直接结束仍在准备的进程。
          await entry.connection.prebuild(key.engine, key.cwd);
          if (!isCurrent()) throw new Error("External engine spare superseded");
          entry.readyAt = now();
          armExpiry(entry);
          logger?.info("External engine spare ready", {
            ...fields(key),
            event: "external_engine.spare.ready",
            durationMs: entry.readyAt - entry.startedAt,
          });
        } catch (error) {
          // 预建会话只是加速手段：失败不进入任何会话状态，下一次新会话冷启动。
          if (isCurrent())
            logger?.warn("External engine spare failed", {
              ...fields(key),
              event: "external_engine.spare.failed",
              code: failureCode(error),
            });
          await discardSpare(entry);
        }
      })();
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
    sweepIdle,
    async close() {
      closed = true;
      stopSweepIfIdle();
      const entries = [...spares.values()];
      await Promise.all(
        entries.map(async (entry) => {
          await discardSpare(entry);
          // 仍在 spawn/initialize/session/new 的预建会话：等启动任务收口（其 catch 会再次关闭），不留孤儿。
          await entry.task;
        }),
      );
    },
  };
}
