import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ExternalEngineConnectionError,
  type ExternalEnginePort,
  type ExternalEngineSessionInput,
} from "@zcode/contracts";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  defaultEngineConnectionProfileId,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
  type ExternalSessionEngine,
} from "@zcode/shared";
import { spawnAcpProcess } from "../exec/acp-process.js";
import { AcpConnection } from "./connection.js";
import { resolveExternalEngineLaunch } from "@zcode/shared/node";
import { resolveEngineConnection } from "./connection-profile.js";
import {
  adapterLaunchArgs,
  ensureNodeRuntimeOnPath,
  withNetworkEgressEnv,
} from "./adapter-env.js";
import type { ExternalEngineAdapterOptions } from "./contract.js";
import type { ExternalEngineSpareKey } from "./process-pool.js";
export { runExternalEngineConnectionTest } from "./connection-test.js";
export {
  createExternalEngineProcessPool,
  type ExternalEngineProcessPool,
  type ExternalEngineProcessPoolOptions,
} from "./process-pool.js";

const LOG_MODULE = "adapters.external_engine";

type LaunchInput = Pick<
  ExternalEngineSessionInput,
  "engine" | "connectionProfileId" | "externalSessionId" | "onConnectionProfile"
>;
interface Launch {
  entry: string;
  /** adapter 进程参数（含是否移除 Node 模式变量的预加载），由 adapterLaunchArgs 决定。 */
  args: string[];
  env: NodeJS.ProcessEnv;
  profileId: string;
  setup?: (connection: AcpConnection) => Promise<void>;
}
/** 会话级连接事实：在途计数与最近使用时间供闲置关闭判断，连接本身仍在 sessions 表。 */
interface SessionActivity {
  engine: ExternalSessionEngine;
  inFlight: number;
  lastUsedAt: number;
  resumable: boolean;
  idleClosedAt?: number;
}

function failureCode(error: unknown): string {
  return error instanceof ExternalEngineConnectionError ? error.failure.code : "request";
}

export function createExternalEnginePort(
  options: ExternalEngineAdapterOptions = {},
): ExternalEnginePort {
  const sessions = new Map<string, AcpConnection>();
  const env = options.env ?? process.env;
  const executable = options.executable ?? process.execPath;
  const pool = options.processPool;
  const logger = options.logger;
  const preparations = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const activities = new Map<string, SessionActivity>();
  const providersSetMs = new WeakMap<AcpConnection, number>();

  const activityFor = (sessionId: string, engine: ExternalSessionEngine): SessionActivity => {
    let activity = activities.get(sessionId);
    if (activity) return activity;
    const created: SessionActivity = {
      engine,
      inFlight: 0,
      lastUsedAt: Date.now(),
      resumable: false,
    };
    activity = created;
    activities.set(sessionId, created);
    pool?.trackSession(sessionId, {
      engine,
      readConnection: () => {
        if (sessions.get(sessionId)?.healthy !== true) return undefined;
        return {
          busy: created.inFlight > 0 || preparations.has(sessionId),
          resumable: created.resumable,
          lastUsedAt: created.lastUsedAt,
        };
      },
      async releaseIdle() {
        const connection = sessions.get(sessionId);
        // 与 execute 取连接处于同一同步片：复查在途后摘除，之后到达的操作走恢复路径。
        if (!connection || created.inFlight > 0 || preparations.has(sessionId)) return false;
        sessions.delete(sessionId);
        created.idleClosedAt = Date.now();
        await connection.close();
        return true;
      },
    });
    return activity;
  };

  const resolveLaunch = async (input: LaunchInput): Promise<Launch> => {
    const runtime = EXTERNAL_ENGINE_RUNTIMES[input.engine];
    const root = env[EXTERNAL_ENGINES_DIR_ENV];
    const home = env[EXTERNAL_ENGINE_USER_HOME_ENV];
    if (!root || !isAbsolute(root) || (home !== undefined && !isAbsolute(home)))
      throw new ExternalEngineConnectionError({ code: "not_ready" });
    const entry = join(
      root,
      managedAdapterInstallDirName(runtime),
      ...managedAdapterEntrySegments(runtime),
    );
    try {
      await access(entry);
    } catch {
      throw new ExternalEngineConnectionError({ code: "not_ready" });
    }
    let childEnv: NodeJS.ProcessEnv = {
      ...env,
      // Electron Helper 默认进入桌面模式；ACP 和其 Node 子进程必须显式沿用 Node 模式。
      ELECTRON_RUN_AS_NODE: "1",
      ...(home ? { HOME: home, USERPROFILE: home } : {}),
    };
    for (const key of Object.keys(childEnv))
      if (key.toUpperCase() === runtime.officialExecutableEnvVar.toUpperCase())
        delete childEnv[key];
    const official = await resolveExternalEngineLaunch(
      runtime,
      childEnv,
      join(root, managedAdapterInstallDirName(runtime)),
    );
    if (official) childEnv[runtime.officialExecutableEnvVar] = official;
    else delete childEnv[runtime.officialExecutableEnvVar];
    // 1.0.7 只在 macOS/Linux 补 node 入口：Windows 无系统 Node 时 adapter 自带的 codex.js 无法启动。
    await ensureNodeRuntimeOnPath(root, executable, childEnv);
    // 计费与网关变量按会话绑定的连接方式处理（含 APP_SERVER_LOGS），规则见共享 buildEngineConnectionEnv。
    const resolved = await resolveEngineConnection(root, input, childEnv);
    // 修复前沿用 CLI 时 adapter 丢失用户的代理/证书变量；按工具子进程的既有规则恢复，YCode 显式配置优先。
    childEnv = withNetworkEgressEnv(resolved.env, env);
    return {
      entry,
      args: adapterLaunchArgs(entry, official),
      env: childEnv,
      profileId: resolved.profile.id,
      ...(resolved.setup ? { setup: resolved.setup } : {}),
    };
  };

  const spawnConnection = (launch: Launch, cwd: string): AcpConnection => {
    const setup = launch.setup;
    return new AcpConnection(
      spawnAcpProcess(executable, launch.args, cwd, launch.env),
      setup
        ? async (target) => {
            const startedAt = Date.now();
            await setup(target);
            providersSetMs.set(target, Date.now() - startedAt);
          }
        : undefined,
    );
  };

  const execute = async <T>(
    input: ExternalEngineSessionInput,
    operation: (connection: AcpConnection) => Promise<T>,
    mode: "session" | "fork" = "session",
  ): Promise<T> => {
    const activity = activityFor(input.sessionId, input.engine);
    // 同步登记在途：闲置关闭与本次取连接不会交错。
    activity.inFlight += 1;
    const startedAt = Date.now();
    let launching = false;
    let established:
      | {
          spare: "hit" | "miss" | "none";
          launchMs: number;
          fresh: boolean;
          key: ExternalEngineSpareKey;
        }
      | undefined;
    try {
      let connection = sessions.get(input.sessionId);
      if (connection && !connection.healthy) {
        sessions.delete(input.sessionId);
        await connection.close();
        connection = undefined;
      }
      if (!connection) {
        launching = true;
        const launch = await resolveLaunch(input);
        // 路径探测含异步 IO；关闭会话后不能由迟到的探测重新创建进程。
        input.signal.throwIfAborted();
        const key = { engine: input.engine, connectionProfileId: launch.profileId, cwd: input.cwd };
        // 只有 session/new 领用备用进程：resume/load/fork 走原连接恢复语义。
        const fresh = mode === "session" && !input.externalSessionId;
        const claimed = fresh ? pool?.claimSpare(key) : undefined;
        connection = claimed ?? spawnConnection(launch, input.cwd);
        established = {
          spare: !fresh || !pool ? "none" : claimed ? "hit" : "miss",
          launchMs: Date.now() - startedAt,
          fresh,
          key,
        };
        sessions.set(input.sessionId, connection);
      }
      let result: T;
      try {
        result = await operation(connection);
      } catch (error) {
        // 网关请求拒绝不等于进程断联；保留健康会话，不能重发已提交的 prompt。
        const requestFailed =
          connection.healthy &&
          error instanceof ExternalEngineConnectionError &&
          error.failure.method === "session/prompt" &&
          ["provider", "authentication", "request"].includes(error.failure.code);
        if (!requestFailed) {
          if (sessions.get(input.sessionId) === connection) sessions.delete(input.sessionId);
          await connection.close();
        }
        throw error;
      }
      if (established) {
        activity.resumable = Boolean(input.externalSessionId) || mode === "fork";
        const handshake = connection.lastHandshake;
        const setupMs = providersSetMs.get(connection);
        logger?.info("External engine handshake completed", {
          module: LOG_MODULE,
          event: "external_engine.handshake.completed",
          engine: input.engine,
          sessionId: input.sessionId,
          method: handshake?.method,
          spare: established.spare,
          launchMs: established.launchMs,
          ...(handshake
            ? {
                initializeMs: Math.max(
                  0,
                  handshake.initializeMs - (established.spare === "hit" ? 0 : (setupMs ?? 0)),
                ),
                ...(setupMs !== undefined && established.spare !== "hit"
                  ? { providersSetMs: setupMs }
                  : {}),
                sessionMs: handshake.sessionMs,
                configRestoreMs: handshake.configRestoreMs,
              }
            : {}),
          totalMs: Date.now() - startedAt,
        });
        // 新会话成功后才补位：配置与引擎已证实可用，且补位不与本次握手争抢启动资源。
        if (established.fresh && pool) {
          const { key } = established;
          pool.refillSpare(key, async () =>
            spawnConnection(
              await resolveLaunch({
                engine: key.engine,
                connectionProfileId: key.connectionProfileId,
              }),
              key.cwd,
            ),
          );
        }
      }
      return result;
    } catch (error) {
      if (launching && !input.signal.aborted)
        logger?.info("External engine handshake failed", {
          module: LOG_MODULE,
          event: "external_engine.handshake.failed",
          engine: input.engine,
          sessionId: input.sessionId,
          code: failureCode(error),
          ...(error instanceof ExternalEngineConnectionError && error.failure.method
            ? { method: error.failure.method }
            : {}),
          totalMs: Date.now() - startedAt,
        });
      throw error;
    } finally {
      activity.inFlight -= 1;
      activity.lastUsedAt = Date.now();
    }
  };
  const prepareSession = (input: ExternalEngineSessionInput): Promise<void> => {
    const existing = preparations.get(input.sessionId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const preparing = { controller, promise: Promise.resolve() };
    preparations.set(input.sessionId, preparing);
    const idleClosedAt = activities.get(input.sessionId)?.idleClosedAt;
    const startedAt = Date.now();
    preparing.promise = (async () => {
      let externalSessionId = input.externalSessionId;
      let connectionProfileId = input.connectionProfileId;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          const attemptInput = {
            ...input,
            signal,
            externalSessionId,
            // 首次解析出的连接配置在重试中固定，避免上次使用值在退避期间变化导致改绑身份。
            connectionProfileId,
            async onSession(id: string) {
              externalSessionId = id;
              await input.onSession(id);
            },
            async onConnectionProfile(id: string) {
              connectionProfileId = id;
              await input.onConnectionProfile?.(id);
            },
          };
          await execute(attemptInput, (connection) => connection.prepare(attemptInput));
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof ExternalEngineConnectionError) || attempt >= 2) throw error;
          const { code, method, rpcCode } = error.failure;
          const transient =
            code === "transport" ||
            code === "timeout" ||
            (code === "request" && rpcCode === -32603);
          // 未确认的新建请求可能已创建原生上下文；不能通过重发制造第二个未知会话。
          if (!transient || (!externalSessionId && method !== "initialize")) throw error;
          await delay(attempt === 0 ? 500 : 1500, undefined, { signal });
        }
      }
    })()
      .then(
        () => logIdleResume(input, idleClosedAt, startedAt),
        (error: unknown) => {
          if (!signal.aborted) logIdleResume(input, idleClosedAt, startedAt, error);
          throw error;
        },
      )
      .finally(() => {
        if (preparations.get(input.sessionId) === preparing) preparations.delete(input.sessionId);
      });
    return preparing.promise;
  };
  const logIdleResume = (
    input: ExternalEngineSessionInput,
    idleClosedAt: number | undefined,
    startedAt: number,
    error?: unknown,
  ) => {
    if (idleClosedAt === undefined) return;
    const activity = activities.get(input.sessionId);
    if (activity?.idleClosedAt === idleClosedAt && error === undefined)
      activity.idleClosedAt = undefined;
    logger?.info(
      error === undefined
        ? "External engine idle session resumed"
        : "External engine idle session resume failed",
      {
        module: LOG_MODULE,
        event:
          error === undefined
            ? "external_engine.idle_resume.completed"
            : "external_engine.idle_resume.failed",
        engine: input.engine,
        sessionId: input.sessionId,
        durationMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { code: failureCode(error) }),
      },
    );
  };
  return {
    prepareSession,
    isSessionConnected: (sessionId) => sessions.get(sessionId)?.healthy === true,
    async forkSession(input) {
      if (sessions.has(input.sessionId) || preparations.has(input.sessionId))
        throw new ExternalEngineConnectionError({ code: "configuration", method: "session/fork" });
      const controller = new AbortController();
      const forkInput = {
        ...input,
        externalSessionId: undefined,
        // 无绑定的旧源会话按 1.0.7 行为解析：Codex 沿用 CLI，Claude 官方登录。
        connectionProfileId:
          input.connectionProfileId ?? defaultEngineConnectionProfileId(input.engine),
        signal: AbortSignal.any([input.signal, controller.signal]),
      };
      // session/fork 已发出后可能已创建 child；响应丢失时不能自行重试制造第二份上下文。
      const preparing = { controller, promise: Promise.resolve() };
      preparations.set(input.sessionId, preparing);
      const pending = execute(
        forkInput,
        (connection) => connection.fork(forkInput, input.parentExternalSessionId),
        "fork",
      );
      preparing.promise = pending.then(() => {});
      void preparing.promise.catch(() => {});
      try {
        return await pending;
      } finally {
        if (preparations.get(input.sessionId) === preparing) preparations.delete(input.sessionId);
      }
    },
    async runTurn(input) {
      await prepareSession(input);
      // 连接就绪后只提交一次 prompt；响应丢失也不能自行重发用户操作。
      return execute(input, (connection) => {
        // 提交过 prompt 的原生会话已落盘，闲置关闭后可经 resume 恢复。
        const activity = activities.get(input.sessionId);
        if (activity) activity.resumable = true;
        return connection.run(input);
      });
    },
    async setConfigOption(sessionId, configId, value) {
      const connection = sessions.get(sessionId);
      if (!connection) throw new ExternalEngineConnectionError({ code: "not_ready" });
      const activity = activities.get(sessionId);
      if (activity) activity.inFlight += 1;
      try {
        return await connection.setConfigOption(configId, value);
      } catch (error) {
        // 配置业务拒绝不代表连接损坏；关闭健康进程会把同时运行的 prompt 一并中断。
        if (!connection.healthy) {
          if (sessions.get(sessionId) === connection) sessions.delete(sessionId);
          await connection.close();
        }
        throw error;
      } finally {
        if (activity) {
          activity.inFlight -= 1;
          activity.lastUsedAt = Date.now();
        }
      }
    },
    async cancelSubagent(sessionId, nativeSessionId) {
      const connection = sessions.get(sessionId);
      if (!connection?.healthy) throw new ExternalEngineConnectionError({ code: "not_ready" });
      connection.cancelSubagent(nativeSessionId);
    },
    async closeSession(sessionId) {
      const preparing = preparations.get(sessionId);
      preparing?.controller.abort(new Error("ACP preparation cancelled"));
      const connection = sessions.get(sessionId);
      sessions.delete(sessionId);
      activities.delete(sessionId);
      pool?.untrackSession(sessionId);
      await connection?.close();
      await preparing?.promise.catch(() => {});
    },
  };
}
