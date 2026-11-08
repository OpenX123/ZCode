import { takeCoverage } from "node:v8";

const DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS = 2_000;
export const DEFAULT_CLI_CLEANUP_TIMEOUT_MS = 6_000;
const DEFAULT_CLI_EXIT_WATCHDOG_TIMEOUT_MS = 1_000;
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

type SignalListener = () => void;

export interface CliShutdownProcess {
  platform: NodeJS.Platform;
  off(signal: NodeJS.Signals, listener: SignalListener): unknown;
  once(signal: NodeJS.Signals, listener: SignalListener): unknown;
}

interface CliShutdownOptions {
  abort?: (signal: NodeJS.Signals) => void;
  cleanup: () => Promise<void> | void;
  cleanupTimeoutMs?: number;
  exitProcess?: (code: number) => void;
  process?: CliShutdownProcess;
}

interface CliExitWatchdogOptions {
  exitCode: number;
  exitProcess?: (code: number) => void;
  timeoutMs?: number;
}

export function registerCliShutdownHandlers(options: CliShutdownOptions): () => void {
  const signalTarget = options.process ?? process;
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const cleanupTimeoutMs = Math.max(
    0,
    Math.trunc(options.cleanupTimeoutMs ?? DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS),
  );
  const signals = shutdownSignals(signalTarget.platform);
  const listeners: Array<[NodeJS.Signals, SignalListener]> = [];
  let disposed = false;
  let shuttingDown = false;

  const unregister = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      signalTarget.off(signal, listener);
    }
  };

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // detached shell processes form their own process group, so parent
    // process shutdown must explicitly close the app before Node exits.
    options.abort?.(signal);
    await runCliCleanupWithTimeout(options.cleanup, cleanupTimeoutMs);
    await flushE2ECoverage();
    unregister();
    exitProcess(exitCodeForSignal(signal));
  };

  for (const signal of signals) {
    const listener = () => {
      void shutdown(signal);
    };
    signalTarget.once(signal, listener);
    listeners.push([signal, listener]);
  }

  return unregister;
}

export async function flushE2ECoverage(): Promise<void> {
  if (process.env.ZCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return;
  }
  try {
    // Agent shutdown 最终调用 process.exit，SIGTERM 路径不会可靠触发
    // NODE_V8_COVERAGE 的自动落盘；只在 E2E coverage 模式下显式刷新。
    takeCoverage();
    // takeCoverage 会把写盘交给 V8 后台任务；立即 process.exit 偶发只留下 readiness
    // marker。coverage 模式留出短暂落盘窗口，普通 CLI shutdown 不增加延迟。
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  } catch {
    // coverage 是诊断产物，写盘失败不能阻塞 CLI 的既有退出流程。
  }
}

function shutdownSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

export async function runCliCleanupWithTimeout(
  cleanup: () => Promise<void> | void,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const cleanupPromise = Promise.resolve().then(cleanup);
    if (timeoutMs === 0) {
      await cleanupPromise;
      return;
    }

    await Promise.race([
      cleanupPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch {
    // Shutdown cleanup is best-effort; exiting should not be blocked by a
    // failing adapter close path.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const PREPARE_STORAGE_FLAG = "--prepare-storage";

export type CliOneShotExitPlan = "immediate" | "watchdog" | "none";

/**
 * 一次性 CLI 命令 run() 返回后的退出方式（协议服务由 protocol lifecycle 退出，不经此处）：
 * - `--prepare-storage`：immediate。Host 在 Worker 中运行它，实测约 1.9s 中约 1.0s 在等 1s watchdog
 *   （Worker 的 stdio 句柄让事件循环不会自然排空）；Host 仍以 Worker 退出码作为退出确认（SILENTDB-06）。
 * - plugin-host 成功返回：none，其 stdio 句柄正是服务的存活条件。
 * - 其余：watchdog，保留原 1s 兜底以免未知句柄让进程悬挂。
 */
export function cliOneShotExitPlan(options: {
  argv: readonly string[];
  exitCode: number;
  pluginHost?: boolean;
}): CliOneShotExitPlan {
  if (options.argv.includes(PREPARE_STORAGE_FLAG)) return "immediate";
  if (options.pluginHost && options.exitCode === 0) return "none";
  return "watchdog";
}

/** 等该流此前已排队的写全部完成（写回调按序触发）；已结束或已销毁的流直接返回。 */
function flushWritable(stream: NodeJS.WritableStream): Promise<void> {
  const writable = stream as NodeJS.WritableStream & {
    destroyed?: boolean;
    writableEnded?: boolean;
  };
  if (writable.destroyed || writable.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      writable.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * immediate 退出：先等 stdout/stderr 已排队的写（结果帧、诊断）完成，再以原退出码退出。
 * 不引入任何等待期限；Worker 中 `process.exit` 只结束该 Worker 线程。
 */
export async function exitCliAfterOneShot(options: {
  exitCode: number;
  streams?: readonly NodeJS.WritableStream[];
  exitProcess?: (code: number) => void;
}): Promise<void> {
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  await Promise.all((options.streams ?? [process.stdout, process.stderr]).map(flushWritable));
  await flushE2ECoverage();
  exitProcess(options.exitCode);
}

export function scheduleCliExitWatchdog(options: CliExitWatchdogOptions): () => void {
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const timeoutMs = Math.max(
    1,
    Math.trunc(options.timeoutMs ?? DEFAULT_CLI_EXIT_WATCHDOG_TIMEOUT_MS),
  );
  const timer = setTimeout(() => {
    // 正常 run() 已完成后仍可能残留未知 pipe/socket handle。watchdog
    // 只在 event loop 到 deadline 仍未耗尽时执行，因此不会延迟自然退出路径。
    void flushE2ECoverage().finally(() => exitProcess(options.exitCode));
  }, timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
