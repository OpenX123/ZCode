import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveExternalEngineCli,
  resolveExternalEngineLaunch,
  atomicWritePrivateTextFile,
} from "@zcode/shared/node";
import { Emitter } from "@zcode/rpc";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  buildEngineConnectionEnv,
  engineConnectionGatewayHost,
  findEngineConnectionProfile,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
  type ExternalEngineConnectionProfile,
  type ExternalEngineConnectionTestInput,
  type ExternalEngineConnectionTestResult,
  type ExternalEngineConnectionsView,
  type ExternalEngineStatus,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import {
  terminateProcessTreeAndWait,
  shouldSpawnInDetachedProcessGroup,
} from "../process/processTreeTerminator.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IExternalEngineService } from "./contract.js";
import type { ICredentialService } from "../credential/credential.js";
import { createEngineConnections } from "./connections.js";
import { detectClaudeGatewayHost, detectCodexGatewayHost } from "./gatewayDetection.js";

const logger = createServiceLogger("external-engine");
// 设置页登录按钮的官方命令；Claude 显式选择订阅登录，与「官方登录」方式一致。
const LOGIN_ARGS: Record<ExternalSessionEngine, readonly string[]> = {
  codex: ["login"],
  "claude-code": ["auth", "login", "--claudeai"],
};

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
interface CommandOptions {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}
export {
  createExternalEngineSpareSelection,
  type ExternalEngineSpareSelection,
  type ExternalEngineSpareSelectionDeps,
} from "./spareSelection.js";

export interface ExternalEngineServiceOptions {
  enginesDir: string;
  env: NodeJS.ProcessEnv;
  credentials?: ICredentialService;
  now?: () => number;
  runCommand?: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  /** 经本地 workspace 的 CLI 执行连接测试（正式 ACP 启动路径）；未装配时测试不可用。 */
  testConnection?: (
    input: ExternalEngineConnectionTestInput & { signal: AbortSignal },
  ) => Promise<ExternalEngineConnectionTestResult>;
}

// 子进程输出可能含账号或凭据；只在内存中解析，错误和日志绝不拼接 stdout/stderr。
function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("external_engine_process_interrupted"));
      return;
    }
    const processStartedAtMs = Date.now();
    const windowsBatch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    // Windows 的 npm/官方 CLI 可能是 .cmd shim；只允许固定参数和无 shell 元字符的路径。
    // 不能把不受信任的输出或用户 prompt 拼进 cmd.exe。
    if (windowsBatch && [command, ...args].some((value) => /[%!^&|<>"\r\n]/.test(value))) {
      reject(new Error("external_engine_process_failed"));
      return;
    }
    const child = spawn(
      windowsBatch ? (options.env.ComSpec ?? "cmd.exe") : command,
      windowsBatch
        ? ["/d", "/s", "/c", `"${[command, ...args].map((value) => `"${value}"`).join(" ")}"`]
        : [...args],
      {
        ...(windowsBatch ? { windowsVerbatimArguments: true } : {}),
        env: options.env,
        detached: shouldSpawnInDetachedProcessGroup(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const maxOutput = 64 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(0, maxOutput);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, maxOutput);
    });
    let finished = false;
    let terminating: Promise<void> | undefined;
    const clear = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", terminate);
    };
    const interrupted = () => {
      if (finished) return;
      finished = true;
      clear();
      reject(new Error("external_engine_process_interrupted"));
    };
    // 退出时等待整个安装/状态命令进程树，不能仅杀 Windows cmd shim 或 npm 父进程。
    const terminate = () => {
      if (finished || terminating) return;
      terminating = terminateProcessTreeAndWait(child, {
        ...(process.platform === "win32" ? {} : { ownedProcessGroupId: child.pid }),
        ownedProcessStartedAtMs: processStartedAtMs,
      }).then(interrupted, interrupted);
    };
    const timer = setTimeout(terminate, options.timeoutMs);
    timer.unref();
    options.signal.addEventListener("abort", terminate, { once: true });
    if (options.signal.aborted) terminate();
    child.once("error", () => {
      if (finished || terminating) return;
      finished = true;
      clear();
      reject(new Error("external_engine_process_failed"));
    });
    child.once("close", (code, signal) => {
      if (finished || terminating) return;
      finished = true;
      clear();
      if (signal) reject(new Error("external_engine_process_interrupted"));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function exists(path: string, executable = false): Promise<boolean> {
  try {
    await access(path, executable ? constants.X_OK : constants.F_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return false;
    throw error;
  }
}

function versionFromOutput(output: string): string | undefined {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
}

function authStatus(
  engine: ExternalSessionEngine,
  result: CommandResult,
): ExternalEngineStatus["auth"] {
  if (engine === "claude-code") {
    let data: unknown;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      return { state: "unknown" };
    }
    if (typeof data !== "object" || data === null) return { state: "unknown" };
    const status = data as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiProvider?: unknown;
    };
    if (status.loggedIn === false) return { state: "loggedOut" };
    if (status.loggedIn !== true || result.code !== 0) return { state: "unknown" };
    // 仅映射已知身份类别，不回传 CLI 任意字符串（可能含邮箱、账号或密钥）。
    const label =
      status.authMethod === "claude.ai"
        ? "subscription"
        : status.authMethod === "api_key"
          ? "apiKey"
          : undefined;
    return { state: "loggedIn", ...(label ? { label } : {}) };
  }
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0 && /logged in using chatgpt/i.test(text))
    return { state: "loggedIn", label: "subscription" };
  if (result.code === 0 && /logged in using (?:an? )?api key/i.test(text))
    return { state: "loggedIn", label: "apiKey" };
  if (/not logged in/i.test(text)) return { state: "loggedOut" };
  return { state: "unknown" };
}

export function createExternalEngineService(
  options: ExternalEngineServiceOptions,
): IExternalEngineService & {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
} {
  const run = options.runCommand ?? runCommand;
  const emitter = new Emitter<ExternalEngineStatus>();
  const profilesEmitter = new Emitter<ExternalEngineConnectionsView>();
  const abort = new AbortController();
  const installs = new Map<ExternalSessionEngine, Promise<ExternalEngineStatus>>();
  const commands = new Set<Promise<CommandResult>>();
  const previous = new Map<ExternalSessionEngine, string>();
  const env = { ...options.env };
  const connections = createEngineConnections(options.enginesDir, options.credentials);
  const statusCache = new Map<
    ExternalSessionEngine,
    { value: ExternalEngineStatus; expires: number }
  >();
  const detections = new Map<ExternalSessionEngine, Promise<ExternalEngineStatus>>();
  const diagnosticAborts = new Map<ExternalSessionEngine, AbortController>();
  const installAborts = new Map<ExternalSessionEngine, AbortController>();
  const launchChecks = new Map<ExternalSessionEngine, Promise<boolean>>();
  const generations = new Map<ExternalSessionEngine, number>();
  let loginAbort: AbortController | undefined;
  let loginPending: Promise<void> | undefined;
  let testAbort: AbortController | undefined;
  let testPending: Promise<unknown> | undefined;
  let disposed = false;
  const execute = (
    command: string,
    args: readonly string[],
    timeoutMs = 10_000,
    commandEnv = env,
    signal = abort.signal,
  ) => {
    const pending = run(command, args, { env: commandEnv, signal, timeoutMs });
    commands.add(pending);
    void pending.finally(() => commands.delete(pending)).catch(() => {});
    return pending;
  };
  const installDir = (engine: ExternalSessionEngine) =>
    join(options.enginesDir, managedAdapterInstallDirName(EXTERNAL_ENGINE_RUNTIMES[engine]));
  /** 诊断与登录使用与 CLI 启动相同的环境规则（共享 buildEngineConnectionEnv），不另写剔除列表。 */
  const connectionEnv = (profile: ExternalEngineConnectionProfile): NodeJS.ProcessEnv =>
    buildEngineConnectionEnv({
      env,
      profile,
      ...(profile.engine === "codex" && profile.mode !== "inherit"
        ? { codexHome: connections.home(profile.id) }
        : {}),
    });
  /** 新草稿缺省配置决定设置页的身份诊断；上次使用值失效时回落内置缺省。 */
  const defaultProfile = async (
    engine: ExternalSessionEngine,
  ): Promise<ExternalEngineConnectionProfile> => {
    const current = await connections.read();
    const profileId = await connections.defaultProfileId(engine);
    const profile = findEngineConnectionProfile(current, engine, profileId);
    if (!profile) throw new Error("external_engine_connection_invalid");
    return profile;
  };
  const gatewayHosts = async (
    profile: ExternalEngineConnectionProfile,
  ): Promise<{ effective?: string; inherited?: string }> => {
    const inherited =
      profile.engine === "codex"
        ? await detectCodexGatewayHost(env)
        : await detectClaudeGatewayHost(env, true);
    if (profile.mode === "apiKey")
      return { effective: engineConnectionGatewayHost(profile), inherited };
    if (profile.mode === "inherit") return { effective: inherited, inherited };
    // Claude 官方登录仍会被 settings.json 的 env 改写路由；Codex 官方登录使用专用目录。
    return {
      effective:
        profile.engine === "claude-code" ? await detectClaudeGatewayHost(env, false) : undefined,
      inherited,
    };
  };
  const findLoginProfile = async (profileId: string) => {
    const current = await connections.read();
    const profile =
      findEngineConnectionProfile(current, "claude-code", profileId) ??
      findEngineConnectionProfile(current, "codex", profileId);
    if (!profile || profile.hidden || profile.mode !== "official")
      throw new Error("external_engine_connection_invalid");
    return profile;
  };
  const invalidateStatus = (engine: ExternalSessionEngine) => {
    // 只删已完成缓存仍会复用旧在途请求，配置切换后必须隔离迟到的身份诊断。
    generations.set(engine, (generations.get(engine) ?? 0) + 1);
    statusCache.delete(engine);
    launchChecks.delete(engine);
    detections.delete(engine);
  };
  const detect = async (
    engine: ExternalSessionEngine,
    diagnostics = true,
    generation = generations.get(engine) ?? 0,
    signal = abort.signal,
  ): Promise<ExternalEngineStatus> => {
    if (disposed) throw new Error("external_engine_service_disposed");
    const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
    const directory = installDir(engine);
    let installed = false;
    if (await exists(join(directory, ...managedAdapterEntrySegments(runtime)))) {
      const packagePath = join(
        directory,
        "node_modules",
        ...runtime.adapterPackage.split("/"),
        "package.json",
      );
      const metadata: unknown = JSON.parse(await readFile(packagePath, "utf8"));
      installed =
        typeof metadata === "object" &&
        metadata !== null &&
        "version" in metadata &&
        metadata.version === runtime.adapterVersion;
    }
    const profile = diagnostics ? await defaultProfile(engine) : undefined;
    const diagnosticEnv = profile ? connectionEnv(profile) : env;
    const cli = await resolveExternalEngineLaunch(
      runtime,
      diagnosticEnv,
      installed ? directory : undefined,
    );
    const status: ExternalEngineStatus = {
      engine,
      adapter: installed
        ? { installed, version: runtime.adapterVersion, source: "managed" }
        : { installed: false },
      officialCli: { found: Boolean(cli), ...(cli ? { path: cli } : {}) },
      auth: { state: "unknown" },
      ...(profile ? { connectionProfileId: profile.id } : {}),
      ready: false,
    };
    if (profile) {
      // 网关用户没有官方登录文件；status 只带 host，界面据此显示网关而不是「未登录」。
      const hosts = await gatewayHosts(profile);
      if (hosts.inherited) status.inheritedGatewayHost = hosts.inherited;
      if (hosts.effective) status.auth.gatewayHost = hosts.effective;
    }
    if (cli && profile) {
      const cliEnv = { ...diagnosticEnv };
      try {
        // npm 的官方入口依赖 env node；桌面 PATH 缺 node 时用当前运行时执行脚本。
        const nodeEntry = /\.(?:[cm]?js)$/i.test(await realpath(cli));
        const command = nodeEntry ? process.execPath : cli;
        const prefix = nodeEntry ? [cli] : [];
        if (nodeEntry) cliEnv.ELECTRON_RUN_AS_NODE = "1";
        const version = execute(command, [...prefix, "--version"], 10_000, cliEnv, signal);
        const auth =
          profile.mode === "apiKey"
            ? undefined
            : execute(command, [...prefix, ...runtime.authStatusArgs], 10_000, cliEnv, signal);
        const [versionResult, authResult] = await Promise.all([
          version,
          auth ?? Promise.resolve(undefined),
        ]);
        status.officialCli.version = versionFromOutput(versionResult.stdout);
        if (profile.mode === "apiKey") {
          const key =
            profile.credentialKey && options.credentials
              ? await options.credentials.load(profile.credentialKey)
              : null;
          status.auth = {
            ...status.auth,
            ...(key ? { state: "loggedIn", label: "apiKey" } : { state: "loggedOut" }),
          };
        } else if (authResult) status.auth = { ...status.auth, ...authStatus(engine, authResult) };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["external_engine_process_failed", "external_engine_process_interrupted"].includes(
            error.message,
          )
        )
          throw error;
        status.error = "external_engine_status_failed";
      }
    }
    if (signal.aborted) throw new Error("external_engine_process_interrupted");
    if (profile) {
      const profileFields = { connectionProfileId: profile.id };
      // 管理密钥的存在与沿用 CLI 报告的 API Key 身份都只是本地事实，不能当作远端认证成功。
      status.checks = [
        {
          id: "cli",
          state: status.officialCli.found ? "passed" : "failed",
          source: cli?.startsWith(directory) ? "managed" : "path",
          actions: status.officialCli.found ? [] : ["refresh"],
          ...(status.officialCli.version ? { version: status.officialCli.version } : {}),
        },
        {
          id: "adapter",
          state: installed ? "passed" : "failed",
          source: "managed",
          actions: installed ? [] : ["install"],
          ...(installed ? { version: runtime.adapterVersion } : {}),
        },
        {
          id: "authentication",
          ...profileFields,
          state:
            profile.mode === "apiKey" || status.auth.label === "apiKey"
              ? status.auth.state === "loggedOut"
                ? "failed"
                : "unknown"
              : status.auth.state === "loggedIn"
                ? "passed"
                : status.auth.state === "loggedOut"
                  ? "failed"
                  : "unknown",
          source: profile.mode === "apiKey" ? "credentialStore" : "cli",
          actions:
            profile.mode === "official" && status.auth.state !== "loggedIn"
              ? ["login"]
              : profile.mode === "apiKey" && status.auth.state === "loggedOut"
                ? ["edit"]
                : ["test"],
        },
        {
          id: "route",
          ...profileFields,
          state: "unknown",
          source: profile.mode === "inherit" ? "cli" : "profile",
          actions: ["test"],
          ...(status.auth.gatewayHost ? { gatewayHost: status.auth.gatewayHost } : {}),
        },
      ];
    }
    // 第三方 provider 可无需 OpenAI 账号；可启动性不能由登录文案决定。
    status.ready = installed && status.officialCli.found;
    const serialized = JSON.stringify(status);
    if (
      diagnostics &&
      !disposed &&
      generation === (generations.get(engine) ?? 0) &&
      previous.get(engine) !== serialized
    ) {
      previous.set(engine, serialized);
      emitter.fire(status);
    }
    return status;
  };
  const getStatus = (engine: ExternalSessionEngine): Promise<ExternalEngineStatus> => {
    if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
    const active = detections.get(engine);
    if (active) return active;
    const cached = statusCache.get(engine);
    if (cached && cached.expires > (options.now ?? Date.now)())
      return Promise.resolve(structuredClone(cached.value));
    const generation = generations.get(engine) ?? 0;
    const controller = new AbortController();
    diagnosticAborts.set(engine, controller);
    const pending = detect(
      engine,
      true,
      generation,
      AbortSignal.any([abort.signal, controller.signal]),
    )
      .then((value) => {
        if (!disposed && generation === (generations.get(engine) ?? 0))
          statusCache.set(engine, {
            value,
            expires: (options.now ?? Date.now)() + 60_000,
          });
        return value;
      })
      .finally(() => {
        if (detections.get(engine) === pending) detections.delete(engine);
        if (diagnosticAborts.get(engine) === controller) diagnosticAborts.delete(engine);
      });
    detections.set(engine, pending);
    return pending;
  };
  return {
    getStatus,
    isLaunchReady(engine) {
      if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
      const active = launchChecks.get(engine);
      if (active) return active;
      const pending = detect(engine, false).then((status) => {
        // 缺少 CLI 后用户可能在终端安装；失败结果不缓存，重试无需重启应用。
        if (!status.ready && launchChecks.get(engine) === pending) launchChecks.delete(engine);
        return status.ready;
      });
      launchChecks.set(engine, pending);
      void pending.catch(() => {
        if (launchChecks.get(engine) === pending) launchChecks.delete(engine);
      });
      return pending;
    },
    async invalidateStatus(engine, cancel) {
      if (cancel === "check" || cancel === "install") diagnosticAborts.get(engine)?.abort();
      if (cancel === "install") installAborts.get(engine)?.abort();
      invalidateStatus(engine);
    },
    refreshStatus(engine) {
      invalidateStatus(engine);
      return getStatus(engine);
    },
    getConnectionProfiles: connections.readView,
    async updateConnectionProfiles(command) {
      if (disposed) throw new Error("external_engine_service_disposed");
      try {
        const result = await connections.update(command);
        if (!disposed) profilesEmitter.fire(result.connections);
        return result;
      } finally {
        invalidateStatus(command.engine);
      }
    },
    login(profileId) {
      if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
      if (loginAbort) return Promise.reject(new Error("external_engine_login_running"));
      const controller = new AbortController();
      loginAbort = controller;
      let engine: ExternalSessionEngine | undefined;
      const pending = (async () => {
        try {
          const profile = await findLoginProfile(profileId);
          engine = profile.engine;
          // 只检查 adapter/CLI 是否可启动；登录按钮不应先等待版本和身份诊断。
          const status = await detect(profile.engine, false);
          if (!status?.ready || !status.officialCli.path) throw new Error("engine_not_ready");
          if (profile.engine === "codex") {
            const home = connections.home(profile.id);
            await mkdir(home, { recursive: true });
            // 强制原生凭据写入专用目录，不能覆盖用户系统钥匙串中的 CLI 身份。
            await atomicWritePrivateTextFile(
              join(home, "config.toml"),
              'cli_auth_credentials_store = "file"\n',
            );
          }
          // Claude 官方登录使用用户自己的 Claude 登录；仍剔除继承的 API 变量，避免登录被网关改写。
          const cli = status.officialCli.path;
          const nodeEntry = /\.(?:[cm]?js)$/i.test(await realpath(cli));
          const loginEnv = connectionEnv(profile);
          if (nodeEntry) loginEnv.ELECTRON_RUN_AS_NODE = "1";
          const result = await execute(
            nodeEntry ? process.execPath : cli,
            [...(nodeEntry ? [cli] : []), ...LOGIN_ARGS[profile.engine]],
            180_000,
            loginEnv,
            AbortSignal.any([abort.signal, controller.signal]),
          );
          if (result.code !== 0) throw new Error("external_engine_login_failed");
          if (profile.engine === "codex") connections.markManagedCodexAuth(profile.id);
        } finally {
          loginAbort = undefined;
          if (engine) invalidateStatus(engine);
        }
      })();
      loginPending = pending;
      void pending
        .finally(() => {
          if (loginPending === pending) loginPending = undefined;
        })
        .catch(() => {});
      return pending;
    },
    async cancelLogin() {
      loginAbort?.abort();
    },
    async testConnection(input) {
      if (disposed) throw new Error("external_engine_service_disposed");
      if (testAbort) throw new Error("external_engine_connection_test_running");
      if (!options.testConnection) throw new Error("external_engine_connection_test_unavailable");
      const controller = new AbortController();
      testAbort = controller;
      const signal = AbortSignal.any([abort.signal, controller.signal]);
      const startedAt = Date.now();
      const pending = (async (): Promise<ExternalEngineConnectionTestResult> => {
        try {
          const profile = findEngineConnectionProfile(
            await connections.read(),
            input.engine,
            input.profileId,
          );
          if (!profile) throw new Error("external_engine_connection_invalid");
          if (!input.workspacePath.trim())
            throw new Error("external_engine_connection_test_unavailable");
          // 读取配置期间已取消时不再启动 CLI 测试。
          if (signal.aborted) return { status: "cancelled" };
          try {
            return await options.testConnection!({ ...input, signal });
          } catch (error) {
            // 取消后迟到的传输错误不再是测试失败。
            if (signal.aborted) return { status: "cancelled" };
            throw error;
          }
        } finally {
          if (testAbort === controller) testAbort = undefined;
        }
      })();
      testPending = pending;
      try {
        const result = await pending;
        // 只记录分类、耗时与配置 ID；消息、回复摘要与密钥不进日志。
        logger.info(undefined, "external engine connection test finished", {
          engine: input.engine,
          profileId: input.profileId,
          status: result.status,
          elapsedMs: Date.now() - startedAt,
          ...(result.status === "failed"
            ? {
                failureCode: result.failure.code,
                httpStatus: result.failure.httpStatus,
              }
            : {}),
        });
        return result;
      } finally {
        if (testPending === pending) testPending = undefined;
      }
    },
    async cancelConnectionTest() {
      testAbort?.abort();
    },
    listStatuses: () =>
      Promise.all(
        (Object.keys(EXTERNAL_ENGINE_RUNTIMES) as ExternalSessionEngine[]).map(getStatus),
      ),
    installAdapter(engine) {
      if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
      const active = installs.get(engine);
      if (active) return active;
      invalidateStatus(engine);
      const controller = new AbortController();
      installAborts.set(engine, controller);
      const signal = AbortSignal.any([abort.signal, controller.signal]);
      const pending = (async () => {
        const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
        const npm = await resolveExternalEngineCli("npm", env);
        if (!npm) throw new Error("external_engine_npm_not_found");
        await mkdir(installDir(engine), { recursive: true });
        let result: CommandResult;
        try {
          result = await execute(
            npm,
            [
              "install",
              "--prefix",
              installDir(engine),
              "--registry=https://registry.npmjs.org",
              "--no-audit",
              "--no-fund",
              "--save-exact",
              `${runtime.adapterPackage}@${runtime.adapterVersion}`,
            ],
            180_000,
            env,
            signal,
          );
        } catch {
          throw new Error("external_engine_install_failed");
        }
        if (result.code !== 0) throw new Error("external_engine_install_failed");
        invalidateStatus(engine);
        if (signal.aborted) throw new Error("external_engine_process_interrupted");
        const status = await getStatus(engine);
        if (!status.adapter.installed) throw new Error("external_engine_install_incomplete");
        return status;
      })();
      installs.set(engine, pending);
      void pending
        .finally(() => {
          if (installs.get(engine) === pending) installs.delete(engine);
          if (installAborts.get(engine) === controller) installAborts.delete(engine);
        })
        .catch(() => {});
      return pending;
    },
    onStatusChanged: emitter.event,
    onConnectionProfilesChanged: profilesEmitter.event,
    disposeAll() {
      disposed = true;
      abort.abort();
      emitter.dispose();
      profilesEmitter.dispose();
    },
    async disposeAllAndWait() {
      this.disposeAll();
      await Promise.allSettled([
        ...installs.values(),
        ...commands,
        ...(loginPending ? [loginPending] : []),
        ...(testPending ? [testPending] : []),
      ]);
    },
  };
}
