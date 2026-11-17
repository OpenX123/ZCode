/* eslint-disable max-lines -- Windows 进程树清理需要集中维护跨阶段的安全边界与 deadline。 */
import { ChildProcess } from "node:child_process";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
  isWindowsPid,
} from "#src/process/processTreeSnapshot.js";
import {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import {
  resolveCurrentOwnedIdentities,
  resolveCurrentOwnedIdentitiesAsync,
} from "#src/process/processTreeOwnership.js";
import { waitForProcessTreeTermination } from "#src/process/processTreeWaiter.js";
import {
  hasWindowsProcessQueryInFlight,
  waitForWindowsProcessQuerySlot,
  verifyWindowsProcessIdentitiesAsync,
} from "#src/process/windowsProcessListAsync.js";
import { defaultWindowsTaskkillRunner } from "#src/process/windowsTaskkillRunner.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

export {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
} from "#src/process/processTreeSnapshot.js";
export {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
export type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorLogger,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
  WindowsTaskkillRequest,
  WindowsTaskkillResult,
  WindowsTaskkillRunner,
} from "#src/process/processTreeTypes.js";

const POSIX_TERMINATION_SIGNAL = "SIGTERM";
const POSIX_FORCE_SIGNAL = "SIGKILL";
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS = 750;
const DEFAULT_FORCE_AFTER_MS = 2_000;

interface InternalProcessTreeTerminatorOptions extends ProcessTreeTerminatorOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
  /** 进程身份查询失败，只观察原 ChildProcess，禁止向裸 PID 发送 taskkill。 */
  unverifiedRootOnly?: boolean;
  windowsEntryStartedAtMs?: number;
  windowsNominalForceAtMs?: number;
  windowsHadExplicitDeadline?: boolean;
  isCleanupActive?: () => boolean;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unknownIdentities?: ProcessIdentity[];
  unverifiedRootPid?: number;
}

export function shouldSpawnInDetachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function debug(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.debug?.(options.traceId, message, ...args);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  return getErrorCode(error) === "ESRCH";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scheduleForceCleanup(
  callback: () => void,
  timeoutMs: number,
  keepTimerRef: boolean,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(timeoutMs, 0));
  if (!keepTimerRef) {
    timer.unref();
  }
  return timer;
}

function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `发送 runtime 进程终止信号失败 pid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

function killPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `发送 runtime 进程组终止信号失败 pgid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  options: ProcessTreeTerminatorOptions,
): Promise<void> {
  const timeoutMs = Math.min(
    options.windowsTaskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS,
    Math.floor((options.windowsCleanupDeadlineAtMs ?? Infinity) - Date.now()),
  );
  if (!isWindowsPid(pid) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return;
  const runner = options.windowsTaskkillRunner ?? defaultWindowsTaskkillRunner;
  const startedAt = Date.now();
  debug(options, "Windows runtime 进程树 taskkill started", { force, pid, timeoutMs });
  let result;
  try {
    result = await runner({ force, pid, timeoutMs });
  } catch (error) {
    result = { error };
  }
  debug(options, "Windows runtime 进程树 taskkill completed", {
    durationMs: Date.now() - startedAt,
    force,
    pid,
    success: !result.error,
  });
  if (result.error && isPidAlive(pid)) {
    warn(
      options,
      `${force ? "强制清理" : "请求"} runtime 进程树退出失败 pid=${pid} status=${String(
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? ((result.error as { code?: unknown }).code ?? "unknown")
          : "unknown",
      )}:`,
      result.error,
      result.stderr,
    );
  }
}

function withWindowsEntryBudget<T extends ProcessTreeTerminatorOptions>(options: T): T {
  const internal = options as InternalProcessTreeTerminatorOptions;
  if (process.platform !== "win32" || internal.windowsEntryStartedAtMs !== undefined)
    return options;
  const entry = Date.now();
  const f = options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
  const l = options.windowsTaskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS;
  const g = (options as ProcessTreeTerminatorWaitOptions).waitAfterForceMs ?? 250;
  const valid =
    [f, l, g].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    l >= 1 &&
    Number.isSafeInteger(entry + f + l + g) &&
    (options.windowsCleanupDeadlineAtMs === undefined ||
      (Number.isSafeInteger(options.windowsCleanupDeadlineAtMs) &&
        options.windowsCleanupDeadlineAtMs >= 0));
  return {
    ...options,
    windowsEntryStartedAtMs: entry,
    windowsNominalForceAtMs: entry + f,
    windowsHadExplicitDeadline: options.windowsCleanupDeadlineAtMs !== undefined,
    windowsCleanupDeadlineAtMs: valid
      ? Math.min(options.windowsCleanupDeadlineAtMs ?? Infinity, entry + f + l + g)
      : entry,
  };
}

function originalLiveRootAvailable(
  child: ChildProcess,
  options: InternalProcessTreeTerminatorOptions,
  ownership: ProcessTreeOwnershipResolution,
): boolean {
  // kill 方法的结构替身或旧快照不是 spawn 来源。仅原 ChildProcess 及仍可用的
  // 原生进程句柄允许 root-only 例外；外部 taskkill 仍是非原子的数值 PID 命令。
  const handle = (child as ChildProcess & { _handle?: { kill?: unknown } })._handle;
  return (
    !options.unverifiedRootOnly &&
    child instanceof ChildProcess &&
    Boolean(child.spawnfile) &&
    typeof handle?.kill === "function" &&
    !hasOwnedChildExited(child, options) &&
    !ownership.goneIdentities?.some((identity) => identity.pid === child.pid) &&
    child.pid !== undefined &&
    isPidAlive(child.pid)
  );
}

function hasOwnedChildExited(child: ChildProcess, options: ProcessTreeTerminatorOptions): boolean {
  return (
    child.exitCode !== null ||
    child.signalCode !== null ||
    options.ownedProcessExitedAtMs !== undefined ||
    options.resolveOwnedProcessExitedAtMs?.() !== undefined
  );
}

function terminateWindowsProcessTreeWithOwnership(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
  ownership: ProcessTreeOwnershipResolution,
): void {
  const internal = options as InternalProcessTreeTerminatorOptions;
  const deadline = options.windowsCleanupDeadlineAtMs!;
  const nominalForceAt = internal.windowsNominalForceAtMs!;
  debug(options, "Windows exact PID cleanup scheduled", {
    deadline,
    nominalForceAt,
    now: Date.now(),
  });
  const active = () => Date.now() < deadline && (internal.isCleanupActive?.() ?? true);
  if (!active()) return;
  const rootPid = child.pid!;
  const known = ownership.knownIdentities.filter(
    (identity) => !ownership.goneIdentities?.some((gone) => gone.pid === identity.pid),
  );
  const report = (resolution: ProcessTreeOwnershipResolution) => {
    if (!active()) return;
    const unresolved = known.filter(
      (identity) =>
        resolution.currentIdentities.includes(identity) ||
        resolution.unknownIdentities?.includes(identity),
    );
    internal.onForceCleanup?.({
      identities: unresolved,
      unknownIdentities: resolution.unknownIdentities,
      ...(ownership.childStillOwned && !known.some((identity) => identity.pid === rootPid)
        ? { unverifiedRootPid: rootPid }
        : {}),
    });
  };
  // 旧查询跨 attempt 仍占用时，连 root 例外也不能新增信号。
  if (active() && !hasWindowsProcessQueryInFlight(child) && nominalForceAt > Date.now()) {
    const targets = !hasOwnedChildExited(child, options)
      ? originalLiveRootAvailable(child, internal, ownership)
        ? [rootPid]
        : []
      : ownership.currentIdentities.map((identity) => identity.pid);
    const now = Date.now();
    const observation = Math.min(
      (options as ProcessTreeTerminatorWaitOptions).waitAfterForceMs ?? 250,
      Math.floor(Math.max(0, deadline - now) / 3),
    );
    const flight = Promise.all(
      [...new Set(targets)].map((pid) =>
        runWindowsTaskkill(pid, false, {
          ...options,
          windowsCleanupDeadlineAtMs: deadline - observation,
        }),
      ),
    ).then(() => undefined);
    internal.onGracefulCleanupScheduled?.(flight);
  }
  const beginForce = () => {
    void (async () => {
      if (!active() || !(await waitForWindowsProcessQuerySlot(child, deadline)) || !active())
        return;
      // 必须按实际取得物理占用的 s 重算，而不能把旧查询的结果/预算带入 retry。
      const s = Date.now();
      const r = Math.max(0, Math.floor(deadline - s));
      const o = Math.min(
        (options as ProcessTreeTerminatorWaitOptions).waitAfterForceMs ?? 250,
        Math.floor(r / 3),
      );
      const v = Math.min(WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS, Math.floor((r - o) / 2));
      const commandDeadline = deadline - o;
      if (v < 1 || commandDeadline <= nominalForceAt || commandDeadline - s < 1) return;
      const resolution = await verifyWindowsProcessIdentitiesAsync(
        known,
        s + v,
        child,
        options,
        active,
      );
      if (!active()) return;
      report(resolution);
      const dispatch = async () => {
        if (!active() || Date.now() >= commandDeadline) {
          report(resolution);
          return;
        }
        // M 授权之后原 root 仍可能退出；真实 exit 使该原身份 gone，不能再向复用 PID 发信号。
        const targets = new Set(
          resolution.currentIdentities
            .filter((identity) => identity.pid !== rootPid || !hasOwnedChildExited(child, options))
            .map((identity) => identity.pid),
        );
        if (originalLiveRootAvailable(child, internal, resolution)) targets.add(rootPid);
        await Promise.all(
          [...targets].map((pid) =>
            runWindowsTaskkill(pid, true, {
              ...options,
              windowsCleanupDeadlineAtMs: commandDeadline,
            }),
          ),
        );
        report(resolution);
      };
      if (Date.now() < nominalForceAt) {
        if (!active()) return;
        const timer = scheduleForceCleanup(
          () => {
            void dispatch();
          },
          nominalForceAt - Date.now(),
          Boolean(options.keepForceTimerRef),
        );
        internal.onForceTimerScheduled?.(timer);
      } else await dispatch();
    })();
  };
  const delay = Math.max(0, nominalForceAt - WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS - Date.now());
  if (delay === 0) beginForce();
  else {
    // 非等待式没有 waiter 回调，不能把必要的 timer 创建放入 optional call 参数。
    const timer = scheduleForceCleanup(beginForce, delay, Boolean(options.keepForceTimerRef));
    internal.onForceTimerScheduled?.(timer);
  }
}

function terminateWindowsProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const internal = options as InternalProcessTreeTerminatorOptions;
  if (internal.resolvedOwnership) {
    terminateWindowsProcessTreeWithOwnership(child, options, internal.resolvedOwnership);
    return;
  }
  // 非等待式入口同样只发现一次，所有查询时间从 public entry 的 D 中扣除。
  void captureProcessTreeSnapshotAsync(child, options).then((snapshot) => {
    if (Date.now() >= options.windowsCleanupDeadlineAtMs!) return;
    const identities = [...(snapshot?.identities ?? [])];
    terminateWindowsProcessTreeWithOwnership(
      child,
      { ...options, unverifiedRootOnly: !snapshot } as InternalProcessTreeTerminatorOptions,
      {
        childStillOwned: identities.some((identity) => identity.pid === child.pid),
        currentIdentities: identities,
        knownIdentities: identities,
      },
    );
  });
}

function forceTerminatePosixProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ForceCleanupResult {
  const pid = child.pid!;
  const { childStillOwned, currentIdentities } = resolveCurrentOwnedIdentities(
    child,
    knownIdentities,
    options,
    false,
  );
  const canSignalOwnedGroup =
    childStillOwned || currentIdentities.some((identity) => identity.processGroupId === pid);
  if (canSignalOwnedGroup) {
    killPosixProcessGroup(pid, POSIX_FORCE_SIGNAL, options);
  }
  for (const identity of currentIdentities.toReversed()) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  if (!canSignalOwnedGroup) {
    const rootIdentity = currentIdentities.find((identity) => identity.pid === pid);
    if (rootIdentity) {
      killPid(rootIdentity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: pid } : {}),
  };
}

function terminatePosixProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const ownership =
    internalOptions.resolvedOwnership ??
    resolveCurrentOwnedIdentities(child, internalOptions.knownIdentities ?? [], options);
  const canSignalOwnedGroup =
    ownership.childStillOwned ||
    ownership.currentIdentities.some((identity) => identity.processGroupId === pid);
  const signaledProcessGroup = canSignalOwnedGroup
    ? killPosixProcessGroup(pid, POSIX_TERMINATION_SIGNAL, options)
    : false;

  // detached runtime/MCP 后代不在 root 进程组内；只对创建标识仍匹配的
  // 生前快照成员发信号，避免延迟回收把复用后的同 PID 进程当成旧后代误杀。
  for (const identity of ownership.currentIdentities) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_TERMINATION_SIGNAL, options);
    }
  }
  if (!signaledProcessGroup && ownership.childStillOwned) {
    killPid(pid, POSIX_TERMINATION_SIGNAL, options);
  }

  const forceTimer = scheduleForceCleanup(
    () => {
      // 非等待式关闭不会注入观察回调；强制回收必须先独立执行，
      // 不能作为 optional call 的参数，否则回调缺失时参数也不会求值。
      const result = forceTerminatePosixProcessTree(child, ownership.knownIdentities, options);
      internalOptions.onForceCleanup?.(result);
    },
    options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

export function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): void {
  options = withWindowsEntryBudget(options);
  if (child.pid == null) {
    // 测试替身或极早期 spawn 失败场景可能拿不到 pid。
    // 这时无法按进程组/进程树兜底，但仍保留旧的 child.kill() 关闭语义。
    try {
      child.kill(POSIX_TERMINATION_SIGNAL);
    } catch (error) {
      warn(options, "发送 runtime 进程终止信号失败 pid=unknown:", error);
    }
    return;
  }

  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, options);
    return;
  }
  terminatePosixProcessTree(child, options);
}

export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) return { remainingPids: [] };
  options = withWindowsEntryBudget(options);
  const internal = options as InternalProcessTreeTerminatorOptions;
  const isWindows = process.platform === "win32";
  const cleanupSnapshot =
    options.snapshot?.rootPid === child.pid
      ? options.snapshot
      : options.ownedProcessGroupId === child.pid
        ? captureProcessGroupSnapshot(options.ownedProcessGroupId, options)
        : isWindows
          ? await captureProcessTreeSnapshotAsync(child, options)
          : captureExitedRootDescendantsSnapshot(child.pid, options);
  const snapshotIdentities = [...(cleanupSnapshot?.identities ?? [])];
  const identityVerificationUnavailable =
    isWindows && (!cleanupSnapshot || cleanupSnapshot.identityVerification === "unavailable");
  let initialOwnership: ProcessTreeOwnershipResolution;
  if (isWindows) {
    initialOwnership = {
      childStillOwned:
        !hasOwnedChildExited(child, options) &&
        (identityVerificationUnavailable ||
          snapshotIdentities.some((identity) => identity.pid === child.pid)),
      currentIdentities: snapshotIdentities,
      knownIdentities: snapshotIdentities,
    };
    if (hasOwnedChildExited(child, options)) {
      const now = Date.now();
      const gracefulDeadline = Math.min(
        now + 750,
        internal.windowsNominalForceAtMs! - 750,
        options.windowsCleanupDeadlineAtMs!,
      );
      initialOwnership = {
        ...initialOwnership,
        currentIdentities: [],
        unknownIdentities: snapshotIdentities,
      };
      if (now < gracefulDeadline && snapshotIdentities.length > 0)
        initialOwnership = await resolveCurrentOwnedIdentitiesAsync(
          child,
          snapshotIdentities,
          { ...options, windowsCleanupDeadlineAtMs: gracefulDeadline },
          false,
        );
    }
  } else
    initialOwnership = await resolveCurrentOwnedIdentitiesAsync(child, snapshotIdentities, options);
  return await waitForProcessTreeTermination(
    child,
    identityVerificationUnavailable
      ? ({ ...options, unverifiedRootOnly: true } as ProcessTreeTerminatorWaitOptions)
      : options,
    initialOwnership,
    // 身份查询失败且没有已验证 identity 时，terminator 的 graceful/force
    // targets 都为空。只有存在真实信号目标才为 taskkill flight 预留命令超时；其余
    // 情况保持完整预算，禁止按 Promise 的瞬时 settle 状态激进缩短边界。
    initialOwnership.knownIdentities.length > 0 ||
      (!identityVerificationUnavailable && initialOwnership.childStillOwned),
    terminateProcessTree,
  );
}
