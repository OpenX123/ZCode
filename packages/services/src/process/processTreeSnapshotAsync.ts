import type { ChildProcess } from "node:child_process";
import {
  captureProcessTreeSnapshot,
  captureExitedRootDescendantsSnapshot,
  collectWindowsSnapshotIdentities,
  filterCurrentProcessIdentities,
  isWindowsLifecycleBoundary,
  isWindowsPid,
} from "#src/process/processTreeSnapshot.js";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";
import {
  readWindowsProcessListAsync,
  verifyWindowsProcessIdentitiesAsync,
} from "#src/process/windowsProcessListAsync.js";
export { verifyWindowsProcessIdentityAsync } from "#src/process/windowsProcessListAsync.js";

export async function filterCurrentProcessIdentitiesAsync(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "win32") return filterCurrentProcessIdentities(identities, options);
  if (identities.length === 0) return [];
  return (
    await verifyWindowsProcessIdentitiesAsync(
      identities,
      options.windowsCleanupDeadlineAtMs ?? Date.now() + 750,
      identities,
      options,
    )
  ).currentIdentities;
}

export async function captureProcessTreeSnapshotAsync(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") return captureProcessTreeSnapshot(child, options);
  if (!isWindowsPid(child.pid)) return undefined;
  const processList = await readWindowsProcessListAsync(options, child);
  // 真实 exit 事件是唯一上界；查询完成时间和当前同 PID 行都不能代替原 root。
  const identities = collectWindowsSnapshotIdentities(
    child.pid,
    processList,
    options,
    child.exitCode !== null || child.signalCode !== null,
  );
  return identities.length === 0
    ? undefined
    : {
        rootPid: child.pid,
        descendantPids: identities
          .filter((identity) => identity.pid !== child.pid)
          .map((identity) => identity.pid),
        identities,
      };
}

export async function captureExitedRootDescendantsSnapshotAsync(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") return captureExitedRootDescendantsSnapshot(rootPid, options);
  const { ownedProcessStartedAtMs: start, ownedProcessExitedAtMs: end } = options;
  if (
    !isWindowsPid(rootPid) ||
    !isWindowsLifecycleBoundary(start) ||
    !isWindowsLifecycleBoundary(end) ||
    start >= end
  )
    return undefined;
  const identities = collectWindowsSnapshotIdentities(
    rootPid,
    await readWindowsProcessListAsync(options),
    options,
    true,
  );
  return identities.length === 0
    ? undefined
    : { rootPid, descendantPids: identities.map((identity) => identity.pid), identities };
}
