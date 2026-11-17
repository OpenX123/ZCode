import type { ChildProcess } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

const DEFAULT_FORCE_AFTER_MS = 2_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 250;
const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_LATE_EXIT_OBSERVATION_MS = 750;

interface WaitInternalOptions extends ProcessTreeTerminatorWaitOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
  windowsEntryStartedAtMs?: number;
  windowsNominalForceAtMs?: number;
  windowsHadExplicitDeadline?: boolean;
  isCleanupActive?: () => boolean;
  isIdentityGone?: (identity: ProcessIdentity) => boolean;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  goneIdentities?: ProcessIdentity[];
  unknownIdentities?: ProcessIdentity[];
  unverifiedRootPid?: number;
}

type TerminateProcessTree = (child: ChildProcess, options: ProcessTreeTerminatorOptions) => void;

function warn(options: ProcessTreeTerminatorWaitOptions, message: string): void {
  options.log?.warn(options.traceId, message);
}

function debug(
  options: ProcessTreeTerminatorWaitOptions,
  message: string,
  context?: Record<string, unknown>,
): void {
  options.log?.debug?.(options.traceId, message, context);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return process.platform === "win32" && (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function observeWindowsPid(pid: number): "live" | "gone" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

export async function waitForProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions,
  initialOwnership: ProcessTreeOwnershipResolution,
  hasWindowsTaskkillTargets: boolean,
  terminateProcessTree: TerminateProcessTree,
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) {
    return { remainingPids: [] };
  }

  const waiterStartedAtMs = Date.now();
  const forceAfterMs = Math.max(options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS, 0);
  const waitAfterForceMs = Math.max(options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS, 0);
  const isWindows = process.platform === "win32";
  const ownedChildHasExited = () =>
    hasChildExited(child) ||
    (isWindows &&
      (options.ownedProcessExitedAtMs !== undefined ||
        options.resolveOwnedProcessExitedAtMs?.() !== undefined));
  const windowsTaskkillBudgetMs = hasWindowsTaskkillTargets
    ? Math.max(options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS, 1)
    : 0;
  // Windows 的 graceful taskkill 与 force timer 并发；只要存在已验证信号目标，就保守地
  // 保留一份终态 taskkill 上限。身份不可用且目标集为空时，两条 taskkill flight 都必然
  // 为空，继续预留命令超时只会让 Host 在无法执行任何动作的状态下白等。
  const windowsRelativeDeadlineMs = forceAfterMs + windowsTaskkillBudgetMs + waitAfterForceMs;
  const internal = options as WaitInternalOptions;
  const remainingForce = Math.max(
    0,
    (internal.windowsNominalForceAtMs ?? waiterStartedAtMs + forceAfterMs) - waiterStartedAtMs,
  );
  const localObservation = remainingForce + waitAfterForceMs;
  const pureObservation = !hasWindowsTaskkillTargets;
  const windowsCleanupDeadlineMs = Math.max(
    0,
    Math.min(
      options.windowsCleanupDeadlineAtMs ?? waiterStartedAtMs + windowsRelativeDeadlineMs,
      pureObservation
        ? waiterStartedAtMs +
            (internal.windowsHadExplicitDeadline
              ? Math.max(localObservation, WINDOWS_LATE_EXIT_OBSERVATION_MS)
              : localObservation)
        : Infinity,
    ) - waiterStartedAtMs,
  );
  const knownIdentities = initialOwnership.knownIdentities;

  // 根 child 退出不代表 detached MCP 已退出；等待边界只使用生前快照。
  // 强杀回调会用已复核身份替换跟踪集，禁止等待或重新认领裸 PID。
  return await new Promise<ProcessTreeTerminationResult>((resolve) => {
    let settled = false;
    // ESRCH 是固定身份的单调退出事实；旧 M/晚回调不能重新认领该 PID 的新对象。
    const identityKey = (identity: ProcessIdentity) => `${identity.pid}:${identity.startTime}`;
    const goneIdentities = new Set((initialOwnership.goneIdentities ?? []).map(identityKey));
    const isIdentityGone = (identity: ProcessIdentity) => goneIdentities.has(identityKey(identity));
    // M 仅授权本阶段信号；unknown 仍是固定 K 的未决责任，不能被空过滤或 force 回调丢掉。
    let trackedIdentities = isWindows
      ? initialOwnership.knownIdentities.filter(
          (identity) => !initialOwnership.goneIdentities?.some((gone) => gone.pid === identity.pid),
        )
      : initialOwnership.currentIdentities;
    let unknownPids = new Set(
      (
        initialOwnership.unknownIdentities ?? (isWindows ? initialOwnership.knownIdentities : [])
      ).map((identity) => identity.pid),
    );
    let unverifiedRootPid =
      initialOwnership.childStillOwned &&
      !trackedIdentities.some((identity) => identity.pid === child.pid)
        ? child.pid
        : undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      child.off?.("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      forceTimer = undefined;
      forceWaitTimer = undefined;
      cleanupDeadlineTimer = undefined;
      treePollTimer = undefined;
    };
    const settle = (remainingPids: number[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ remainingPids });
    };
    const refreshWindowsExitEvidence = () => {
      if (!isWindows) return;
      // 每次 OS 探测都在此写入 gone；后续 some/remaining 不再重复探测并丢掉第二次 ESRCH。
      trackedIdentities = trackedIdentities.filter((identity) => {
        if (isIdentityGone(identity)) return false;
        const state =
          identity.pid === child.pid && ownedChildHasExited()
            ? "gone"
            : observeWindowsPid(identity.pid);
        if (state === "gone") {
          goneIdentities.add(identityKey(identity));
          unknownPids.delete(identity.pid);
          return false;
        }
        if (state === "unknown") unknownPids.add(identity.pid);
        return true;
      });
      if (
        unverifiedRootPid !== undefined &&
        (ownedChildHasExited() || observeWindowsPid(unverifiedRootPid) === "gone")
      )
        unverifiedRootPid = undefined;
    };
    const settleIfTreeExited = () => {
      refreshWindowsExitEvidence();
      const hasRunningVerifiedProcess = isWindows
        ? trackedIdentities.length > 0
        : trackedIdentities.some((identity) => isPidAlive(identity.pid));
      const hasRunningUnverifiedRoot =
        unverifiedRootPid !== undefined &&
        !ownedChildHasExited() &&
        (isWindows || isPidAlive(unverifiedRootPid));
      if (!hasRunningVerifiedProcess && !hasRunningUnverifiedRoot) {
        // Windows 的 taskkill callback 可能先于 Node ChildProcess exit 事件。
        // OS 已无 PID 时继续等一轮 exit 投递，避免 transport/lifecycle 在清理 Promise
        // 返回后仍看见旧状态；若 exit 丢失，绝对 deadline 仍会按 OS 事实成功收口。
        if (isWindows && !ownedChildHasExited()) return;
        settle();
      }
    };
    const startTreePolling = () => {
      if (!treePollTimer && !settled) {
        treePollTimer = setInterval(settleIfTreeExited, 25);
      }
    };
    const collectRemainingPids = (): number[] => {
      refreshWindowsExitEvidence();
      const remainingPids = trackedIdentities
        .filter(
          (identity) =>
            !(isWindows && identity.pid === child.pid && ownedChildHasExited()) &&
            (isWindows || isPidAlive(identity.pid)),
        )
        .map((identity) => identity.pid);
      if (
        unverifiedRootPid !== undefined &&
        !ownedChildHasExited() &&
        (isWindows || isPidAlive(unverifiedRootPid))
      ) {
        remainingPids.push(unverifiedRootPid);
      }
      return [...new Set(remainingPids)];
    };
    const onExit = () => {
      unverifiedRootPid = undefined;
      // Windows exit 回调中同步刷新 CIM 进程表会再次阻塞 Host deadline。
      // 此处只观察已固定身份 PID 是否仍存活；真正发送 force 前仍会复核创建标识。
      settleIfTreeExited();
      if (!settled) startTreePolling();
    };
    const scheduleForceWait = () => {
      if (forceWaitTimer || settled) return;
      if (waitAfterForceMs === 0) {
        settle(collectRemainingPids());
        return;
      }
      forceWaitTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树强制回收后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, waitAfterForceMs);
    };
    const scheduleWindowsCleanupDeadline = () => {
      if (!isWindows || cleanupDeadlineTimer || settled) return;
      debug(options, "Windows runtime 进程树 cleanup deadline scheduled", {
        forceAfterMs,
        hasWindowsTaskkillTargets,
        waitAfterForceMs,
        windowsRelativeDeadlineMs,
        windowsTaskkillBudgetMs,
        windowsCleanupDeadlineMs,
        windowsCleanupDeadlineAtMs: options.windowsCleanupDeadlineAtMs,
      });
      cleanupDeadlineTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          const unresolved = remainingPids.filter(
            (pid) => unknownPids.has(pid) || pid === unverifiedRootPid,
          );
          const confirmedLive = remainingPids.filter((pid) => !unresolved.includes(pid));
          warn(
            options,
            `runtime 进程树绝对 deadline 后仍有残留 pid=${remainingPids.join(",")} confirmed-live=${confirmedLive.join(",")} unresolved=${unresolved.join(",")}`,
          );
        }
        settle(remainingPids);
      }, windowsCleanupDeadlineMs);
    };
    const onForceCleanup = (result: ForceCleanupResult) => {
      if (settled || (isWindows && Date.now() >= waiterStartedAtMs + windowsCleanupDeadlineMs))
        return;
      debug(options, "Windows runtime 进程树 force cleanup completed", {
        trackedPids: result.identities.map((identity) => identity.pid),
        unverifiedRootPid: result.unverifiedRootPid,
      });
      // 这里必须替换而不是合并：旧快照身份可能已经失效，继续保留会把新进程
      // 错当成残留，并让后续等待/日志失去进程所有权语义。
      for (const identity of result.goneIdentities ?? []) goneIdentities.add(identityKey(identity));
      trackedIdentities = result.identities.filter(
        (identity) => !isWindows || !isIdentityGone(identity),
      );
      unknownPids = new Set((result.unknownIdentities ?? []).map((identity) => identity.pid));
      unverifiedRootPid = result.unverifiedRootPid;
      settleIfTreeExited();
      if (!settled) {
        startTreePolling();
        if (!isWindows) scheduleForceWait();
      }
    };

    child.once("exit", onExit);
    const waitOptions: WaitInternalOptions = {
      ...options,
      forceAfterMs,
      keepForceTimerRef: true,
      knownIdentities,
      resolvedOwnership: initialOwnership,
      isCleanupActive: () => !settled,
      isIdentityGone,
      onForceCleanup,
      onForceTimerScheduled: (timer) => {
        if (settled) clearTimeout(timer);
        else forceTimer = timer;
      },
      onGracefulCleanupScheduled: (flight) => {
        // runner 自身有 timeout 且 runWindowsTaskkill 会把 rejection 归一化；无论命令结果，
        // flight settle 后都重新观察 OS/ChildProcess 事实，最终失败仍由绝对 deadline 决定。
        void flight.then(() => {
          if (settled) return;
          debug(options, "Windows runtime 进程树 graceful cleanup flight settled");
          settleIfTreeExited();
          if (!settled) startTreePolling();
        });
      },
    };
    scheduleWindowsCleanupDeadline();
    terminateProcessTree(child, waitOptions);

    settleIfTreeExited();
    if (!settled && ownedChildHasExited()) {
      startTreePolling();
    }
  });
}
