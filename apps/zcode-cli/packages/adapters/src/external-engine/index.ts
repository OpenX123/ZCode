import { access, mkdir, symlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
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
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import { spawnAcpProcess } from "../exec/acp-process.js";
import { AcpConnection } from "./connection.js";
import { resolveExternalEngineCli, resolveExternalEngineLaunch } from "@zcode/shared/node";
import { resolveEngineConnection } from "./connection-profile.js";
import type { ExternalEngineAdapterOptions } from "./contract.js";
export function createExternalEnginePort(
  options: ExternalEngineAdapterOptions = {},
): ExternalEnginePort {
  const sessions = new Map<string, AcpConnection>();
  const env = options.env ?? process.env;
  const preparations = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const execute = async <T>(
    input: ExternalEngineSessionInput,
    operation: (connection: AcpConnection) => Promise<T>,
  ): Promise<T> => {
    let connection = sessions.get(input.sessionId);
    if (connection && !connection.healthy) {
      sessions.delete(input.sessionId);
      await connection.close();
      connection = undefined;
    }
    if (!connection) {
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
      // 上游 adapter 的原始帧日志包含 Authorization，任何连接模式都不能继承开启。
      for (const key of Object.keys(childEnv))
        if (key.toUpperCase() === "APP_SERVER_LOGS") delete childEnv[key];
      for (const key of runtime.strippedEnvVars)
        for (const actualKey of Object.keys(childEnv))
          if (actualKey.toUpperCase() === key.toUpperCase()) delete childEnv[actualKey];
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
      // 桌面可能只有 Electron Node 模式，npm 的 env node 入口会以 127 退出。
      // 只补 ACP 子进程 PATH，保持官方 CLI 与当前运行时，不依赖用户另装 Node。
      if (process.platform !== "win32" && !(await resolveExternalEngineCli("node", childEnv))) {
        const executable = options.executable ?? process.execPath;
        const runtimeKey = createHash("sha256").update(executable).digest("hex").slice(0, 16);
        const bin = join(root, ".node-runtime", runtimeKey);
        const node = join(bin, "node");
        await mkdir(bin, { recursive: true });
        try {
          await symlink(executable, node);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if ((await realpath(node)) !== (await realpath(executable)))
            throw new ExternalEngineConnectionError({ code: "not_ready" });
        }
        const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
        childEnv[pathKey] = [bin, childEnv[pathKey]].filter(Boolean).join(delimiter);
      }
      const resolved = await resolveEngineConnection(root, input, childEnv);
      childEnv = resolved.env;
      // 路径探测含异步 IO；关闭会话后不能由迟到的探测重新创建进程。
      input.signal.throwIfAborted();
      connection = new AcpConnection(
        spawnAcpProcess(options.executable ?? process.execPath, [entry], input.cwd, childEnv),
        resolved.setup,
      );
      sessions.set(input.sessionId, connection);
    }
    try {
      return await operation(connection);
    } catch (error) {
      // 网关请求拒绝不等于进程断联；保留健康会话，不能重发已提交的 prompt。
      const requestFailed =
        connection.healthy &&
        error instanceof ExternalEngineConnectionError &&
        error.failure.method === "session/prompt" &&
        ["provider", "authentication", "request"].includes(error.failure.code);
      if (!requestFailed) {
        sessions.delete(input.sessionId);
        await connection.close();
      }
      throw error;
    }
  };
  const prepareSession = (input: ExternalEngineSessionInput): Promise<void> => {
    const existing = preparations.get(input.sessionId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const preparing = { controller, promise: Promise.resolve() };
    preparations.set(input.sessionId, preparing);
    preparing.promise = (async () => {
      let externalSessionId = input.externalSessionId;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          const attemptInput = {
            ...input,
            signal,
            externalSessionId,
            async onSession(id: string) {
              externalSessionId = id;
              await input.onSession(id);
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
    })().finally(() => {
      if (preparations.get(input.sessionId) === preparing) preparations.delete(input.sessionId);
    });
    return preparing.promise;
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
        connectionProfileId: input.connectionProfileId ?? "inherit",
        signal: AbortSignal.any([input.signal, controller.signal]),
      };
      // session/fork 已发出后可能已创建 child；响应丢失时不能自行重试制造第二份上下文。
      const preparing = { controller, promise: Promise.resolve() };
      preparations.set(input.sessionId, preparing);
      const pending = execute(forkInput, (connection) =>
        connection.fork(forkInput, input.parentExternalSessionId),
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
      return execute(input, (connection) => connection.run(input));
    },
    async setConfigOption(sessionId, configId, value) {
      const connection = sessions.get(sessionId);
      if (!connection) throw new ExternalEngineConnectionError({ code: "not_ready" });
      try {
        return await connection.setConfigOption(configId, value);
      } catch (error) {
        // 配置业务拒绝不代表连接损坏；关闭健康进程会把同时运行的 prompt 一并中断。
        if (!connection.healthy) {
          sessions.delete(sessionId);
          await connection.close();
        }
        throw error;
      }
    },
    async closeSession(sessionId) {
      const preparing = preparations.get(sessionId);
      preparing?.controller.abort(new Error("ACP preparation cancelled"));
      const connection = sessions.get(sessionId);
      sessions.delete(sessionId);
      await connection?.close();
      await preparing?.promise.catch(() => {});
    },
  };
}
