import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Emitter } from "@zcode/rpc";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
  type ExternalEngineStatus,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import {
  terminateProcessTreeAndWait,
  shouldSpawnInDetachedProcessGroup,
} from "../process/processTreeTerminator.js";
import type { IExternalEngineService } from "./contract.js";

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

async function commandOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = env.PATH ?? env.Path ?? "";
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (await exists(candidate, true)) return candidate;
    }
  }
  return undefined;
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
  let disposed = false;
  const execute = (
    command: string,
    args: readonly string[],
    timeoutMs = 10_000,
    commandEnv = env,
  ) => {
    const pending = run(command, args, { env: commandEnv, signal: abort.signal, timeoutMs });
    commands.add(pending);
    void pending.finally(() => commands.delete(pending)).catch(() => {});
    return pending;
  };
  const installDir = (engine: ExternalSessionEngine) =>
    join(options.enginesDir, managedAdapterInstallDirName(EXTERNAL_ENGINE_RUNTIMES[engine]));
  const detect = async (engine: ExternalSessionEngine): Promise<ExternalEngineStatus> => {
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
    const pathCli = await commandOnPath(runtime.officialCliCommand, env);
    const bundledCli = join(directory, ...runtime.bundledOfficialCliEntry.split("/"));
    const cli = pathCli ?? (installed && (await exists(bundledCli)) ? bundledCli : undefined);
    const status: ExternalEngineStatus = {
      engine,
      adapter: installed
        ? { installed, version: runtime.adapterVersion, source: "managed" }
        : { installed: false },
      officialCli: { found: Boolean(cli), ...(cli ? { path: cli } : {}) },
      auth: { state: "unknown" },
      ready: false,
    };
    if (cli) {
      const cliEnv = { ...env };
      for (const key of runtime.strippedEnvVars)
        for (const actualKey of Object.keys(cliEnv))
          if (actualKey.toUpperCase() === key.toUpperCase()) delete cliEnv[actualKey];
      try {
        // npm 的官方入口依赖 env node；桌面 PATH 缺 node 时用当前运行时执行脚本。
        const nodeEntry = !pathCli || /\.(?:[cm]?js)$/i.test(await realpath(cli));
        const command = nodeEntry ? process.execPath : cli;
        const prefix = nodeEntry ? [cli] : [];
        if (nodeEntry) cliEnv.ELECTRON_RUN_AS_NODE = "1";
        const version = await execute(command, [...prefix, "--version"], 10_000, cliEnv);
        status.officialCli.version = versionFromOutput(version.stdout);
        status.auth = authStatus(
          engine,
          await execute(command, [...prefix, ...runtime.authStatusArgs], 10_000, cliEnv),
        );
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
    status.ready = installed && status.auth.state === "loggedIn";
    const serialized = JSON.stringify(status);
    if (!disposed && previous.get(engine) !== serialized) {
      previous.set(engine, serialized);
      emitter.fire(status);
    }
    return status;
  };
  return {
    getStatus: detect,
    listStatuses: () =>
      Promise.all((Object.keys(EXTERNAL_ENGINE_RUNTIMES) as ExternalSessionEngine[]).map(detect)),
    installAdapter(engine) {
      if (disposed) return Promise.reject(new Error("external_engine_service_disposed"));
      const active = installs.get(engine);
      if (active) return active;
      const pending = (async () => {
        const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
        const npm = await commandOnPath("npm", env);
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
        const status = await detect(engine);
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
      await Promise.allSettled([...installs.values(), ...commands]);
    },
  };
}
