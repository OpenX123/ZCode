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
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
  type ExternalEngineStatus,
  type ExternalEngineConnectionProfile,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import {
  terminateProcessTreeAndWait,
  shouldSpawnInDetachedProcessGroup,
} from "../process/processTreeTerminator.js";
import type { IExternalEngineService } from "./contract.js";
import type { ICredentialService } from "../credential/credential.js";
import { createEngineConnections } from "./connections.js";

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
    const status = data as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
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
): IExternalEngineService & { disposeAll(): void; disposeAllAndWait(): Promise<void> } {
  const run = options.runCommand ?? runCommand;
  const emitter = new Emitter<ExternalEngineStatus>();
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
  const launchChecks = new Map<ExternalSessionEngine, Promise<boolean>>();
  const generations = new Map<ExternalSessionEngine, number>();
  let loginAbort: AbortController | undefined;
  let loginPending: Promise<void> | undefined;
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
  const managedConnectionEnv = async (
    engine: ExternalSessionEngine,
    selected?: ExternalEngineConnectionProfile,
  ): Promise<{
    env: NodeJS.ProcessEnv;
    profile?: ExternalEngineConnectionProfile;
  }> => {
    if (engine !== "codex") return { env: { ...env }, profile: undefined };
    const profiles = selected ? undefined : await connections.read();
    const profile =
      selected ?? profiles?.profiles.find((item) => item.id === profiles.activeProfileId);
    if (!profile) throw new Error("external_engine_connection_invalid");
    if (profile.mode === "inherit") return { env: { ...env }, profile };
    const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: connections.home(profile.id) };
    // 管理连接不能看到宿主的网关、密钥或原始 ACP 日志开关。
    for (const key of Object.keys(childEnv))
      if (
        [
          "APP_SERVER_LOGS",
          "DEFAULT_AUTH_REQUEST",
          "CODEX_CONFIG",
          "MODEL_PROVIDER",
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "CODEX_API_KEY",
        ].includes(key.toUpperCase())
      )
        delete childEnv[key];
    return { env: childEnv, profile };
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
    const diagnosticContext = diagnostics
      ? await managedConnectionEnv(engine)
      : { env, profile: undefined };
    const cli = await resolveExternalEngineLaunch(
      runtime,
      diagnosticContext.env,
      installed ? directory : undefined,
    );
    const status: ExternalEngineStatus = {
      engine,
      adapter: installed
        ? { installed, version: runtime.adapterVersion, source: "managed" }
        : { installed: false },
      officialCli: { found: Boolean(cli), ...(cli ? { path: cli } : {}) },
      auth: { state: "unknown" },
      ready: false,
    };
    if (cli && diagnostics) {
      const cliEnv = diagnosticContext.env;
      for (const key of runtime.strippedEnvVars)
        for (const actualKey of Object.keys(cliEnv))
          if (actualKey.toUpperCase() === key.toUpperCase()) delete cliEnv[actualKey];
      try {
        // npm 的官方入口依赖 env node；桌面 PATH 缺 node 时用当前运行时执行脚本。
        const nodeEntry = /\.(?:[cm]?js)$/i.test(await realpath(cli));
        const command = nodeEntry ? process.execPath : cli;
        const prefix = nodeEntry ? [cli] : [];
        if (nodeEntry) cliEnv.ELECTRON_RUN_AS_NODE = "1";
        const version = execute(command, [...prefix, "--version"], 10_000, cliEnv);
        const auth =
          diagnosticContext.profile?.mode === "apiKey"
            ? undefined
            : execute(command, [...prefix, ...runtime.authStatusArgs], 10_000, cliEnv);
        const [versionResult, authResult] = await Promise.all([
          version,
          auth ?? Promise.resolve(undefined),
        ]);
        status.officialCli.version = versionFromOutput(versionResult.stdout);
        if (diagnosticContext.profile?.mode === "apiKey") {
          const key =
            diagnosticContext.profile.credentialKey && options.credentials
              ? await options.credentials.load(diagnosticContext.profile.credentialKey)
              : null;
          status.auth = key ? { state: "loggedIn", label: "apiKey" } : { state: "loggedOut" };
        } else if (authResult) status.auth = authStatus(engine, authResult);
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
    const pending = detect(engine, true, generation)
      .then((value) => {
        if (!disposed && generation === (generations.get(engine) ?? 0))
          statusCache.set(engine, { value, expires: (options.now ?? Date.now)() + 60_000 });
        return value;
      })
      .finally(() => {
        if (detections.get(engine) === pending) detections.delete(engine);
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
    async invalidateStatus(engine) {
      invalidateStatus(engine);
    },
    refreshStatus(engine) {
      invalidateStatus(engine);
      return getStatus(engine);
    },
    getConnectionProfiles: connections.read,
    async saveConnectionProfile(input) {
      try {
        return await connections.save(input);
      } finally {
        invalidateStatus("codex");
      }
    },
    login(profileId) {
      if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
      if (loginAbort) return Promise.reject(new Error("external_engine_login_running"));
      const controller = new AbortController();
      loginAbort = controller;
      const pending = (async () => {
        try {
          const profile = (await connections.read()).profiles.find((item) => item.id === profileId);
          if (!profile || profile.mode !== "official")
            throw new Error("external_engine_connection_invalid");
          // 只检查 adapter/CLI 是否可启动；登录按钮不应先等待版本和身份诊断。
          const status = await detect("codex", false);
          if (!status?.ready || !status.officialCli.path) throw new Error("engine_not_ready");
          const home = connections.home(profile.id);
          await mkdir(home, { recursive: true });
          // 强制原生凭据写入专用目录，不能覆盖用户系统钥匙串中的 CLI 身份。
          await atomicWritePrivateTextFile(
            join(home, "config.toml"),
            'cli_auth_credentials_store = "file"\n',
          );
          const cli = status.officialCli.path;
          const nodeEntry = /\.(?:[cm]?js)$/i.test(await realpath(cli));
          const { env: loginEnv } = await managedConnectionEnv("codex", profile);
          if (nodeEntry) loginEnv.ELECTRON_RUN_AS_NODE = "1";
          const result = await execute(
            nodeEntry ? process.execPath : cli,
            [...(nodeEntry ? [cli] : []), "login"],
            180_000,
            loginEnv,
            AbortSignal.any([abort.signal, controller.signal]),
          );
          if (result.code !== 0) throw new Error("external_engine_login_failed");
        } finally {
          loginAbort = undefined;
          invalidateStatus("codex");
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
    listStatuses: () =>
      Promise.all(
        (Object.keys(EXTERNAL_ENGINE_RUNTIMES) as ExternalSessionEngine[]).map(getStatus),
      ),
    installAdapter(engine) {
      if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
      const active = installs.get(engine);
      if (active) return active;
      invalidateStatus(engine);
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
          );
        } catch {
          throw new Error("external_engine_install_failed");
        }
        if (result.code !== 0) throw new Error("external_engine_install_failed");
        invalidateStatus(engine);
        const status = await getStatus(engine);
        if (!status.adapter.installed) throw new Error("external_engine_install_incomplete");
        return status;
      })();
      installs.set(engine, pending);
      void pending
        .finally(() => {
          if (installs.get(engine) === pending) installs.delete(engine);
        })
        .catch(() => {});
      return pending;
    },
    onStatusChanged: emitter.event,
    disposeAll() {
      disposed = true;
      abort.abort();
      emitter.dispose();
    },
    async disposeAllAndWait() {
      this.disposeAll();
      await Promise.allSettled([
        ...installs.values(),
        ...commands,
        ...(loginPending ? [loginPending] : []),
      ]);
    },
  };
}
