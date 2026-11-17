import { execFile } from "node:child_process";
import {
  isWindowsPid,
  parseWindowsCreationTicks,
  parseWindowsProcessList,
} from "#src/process/processTreeSnapshot.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 2_500;
type WindowsCimCapability = "cim" | "identity-unavailable";
interface WindowsProcessListFlight {
  promise: Promise<readonly ProcessIdentity[]>;
  startedAtMs: number;
}
let windowsProcessListInFlight: WindowsProcessListFlight | undefined;
let windowsCimCapability: WindowsCimCapability | undefined;
// 逻辑截止不等于 PowerShell 已退出。占用绑定原 child，跨同一快照的 retry 保留，
// 只有 execFile 的物理完成回调可归还；旧回调不负责派发下一次工作。
const queryFlights = new WeakMap<object, Promise<void>>();

async function beforeDeadline<T>(request: Promise<T>, deadline: number, fallback: T): Promise<T> {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function hasWindowsProcessQueryInFlight(owner: object): boolean {
  return queryFlights.has(owner);
}

export async function waitForWindowsProcessQuerySlot(
  owner: object,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    const previous = queryFlights.get(owner);
    if (!previous) return true;
    const released = await beforeDeadline(
      previous.then(() => true),
      deadline,
      false,
    );
    if (!released) return false;
  }
  return false;
}

function trackQuery<T>(owner: object, request: Promise<T>): Promise<T> {
  const physical = request.then(
    () => undefined,
    () => undefined,
  );
  queryFlights.set(owner, physical);
  void physical.then(() => {
    if (queryFlights.get(owner) === physical) queryFlights.delete(owner);
  });
  return request;
}

function queryWindowsProcesses(
  filter: readonly number[] | undefined,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions,
): Promise<ReturnType<typeof parseWindowsProcessList> | undefined> {
  if (
    timeoutMs < 1 ||
    windowsCimCapability === "identity-unavailable" ||
    filter?.some((pid) => !isWindowsPid(pid))
  )
    return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process${filter ? ` -Filter "${filter.map((pid) => `ProcessId = ${pid}`).join(" OR ")}"` : ""} | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
      ],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES" || code === "EPERM")
            windowsCimCapability = "identity-unavailable";
          options.log?.warn(options.traceId, "Windows CIM 身份查询失败:", error, stderr);
          resolve(undefined);
          return;
        }
        windowsCimCapability = "cim";
        resolve(parseWindowsProcessList(stdout));
      },
    );
  });
}

export async function verifyWindowsProcessIdentitiesAsync(
  identities: readonly ProcessIdentity[],
  deadline: number,
  owner: object,
  options: ProcessTreeTerminatorOptions,
  isActive: () => boolean = () => true,
): Promise<ProcessTreeOwnershipResolution> {
  const currentIdentities: ProcessIdentity[] = [];
  const goneIdentities: ProcessIdentity[] = [];
  const unknownIdentities: ProcessIdentity[] = [];
  for (let index = 0; index < identities.length; index += 64) {
    const batch = identities.slice(index, index + 64);
    if (!isActive() || !(await waitForWindowsProcessQuerySlot(owner, deadline)) || !isActive()) {
      unknownIdentities.push(...identities.slice(index));
      break;
    }
    if (
      batch.some(
        (identity) =>
          !isWindowsPid(identity.pid) ||
          parseWindowsCreationTicks(identity.startTime) === undefined,
      )
    ) {
      unknownIdentities.push(...batch);
      continue;
    }
    const timeout = Math.floor(deadline - Date.now());
    if (timeout < 1) {
      unknownIdentities.push(...identities.slice(index));
      break;
    }
    const parsed = await beforeDeadline(
      trackQuery(
        owner,
        queryWindowsProcesses(
          batch.map((identity) => identity.pid),
          timeout,
          options,
        ),
      ),
      deadline,
      undefined,
    );
    if (
      !isActive() ||
      Date.now() >= deadline ||
      !parsed?.complete ||
      parsed.identities.some((identity) => !batch.some((target) => target.pid === identity.pid))
    ) {
      unknownIdentities.push(...batch);
      continue;
    }
    for (const identity of batch) {
      const rows = parsed.identities.filter((row) => row.pid === identity.pid);
      if (
        rows.length > 1 ||
        (rows.length === 1 &&
          (!isWindowsPid(rows[0]!.parentPid, true) ||
            parseWindowsCreationTicks(rows[0]!.startTime) === undefined))
      )
        unknownIdentities.push(identity);
      else if (rows.length === 0 || rows[0]!.startTime !== identity.startTime)
        goneIdentities.push(identity);
      else currentIdentities.push(identity);
    }
  }
  return {
    childStillOwned: false,
    currentIdentities,
    goneIdentities,
    unknownIdentities,
    knownIdentities: [...identities],
  };
}

export async function verifyWindowsProcessIdentityAsync(
  identity: ProcessIdentity,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<boolean> {
  if (process.platform !== "win32" || timeoutMs <= 0) return false;
  const result = await verifyWindowsProcessIdentitiesAsync(
    [identity],
    Math.min(Date.now() + timeoutMs, options.windowsCleanupDeadlineAtMs ?? Infinity),
    identity,
    options,
  );
  return result.currentIdentities.length === 1;
}

export async function readWindowsProcessListAsync(
  options: ProcessTreeTerminatorOptions,
  owner?: object,
): Promise<readonly ProcessIdentity[]> {
  if (windowsCimCapability === "identity-unavailable") return [];
  const deadline =
    options.windowsCleanupDeadlineAtMs ?? Date.now() + WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS;
  const spawn = options.ownedProcessStartedAtMs;
  if (
    windowsProcessListInFlight &&
    (spawn === undefined || spawn < windowsProcessListInFlight.startedAtMs)
  ) {
    const request = owner
      ? trackQuery(owner, windowsProcessListInFlight.promise)
      : windowsProcessListInFlight.promise;
    return await beforeDeadline(request, deadline, []);
  }
  if (owner && !(await waitForWindowsProcessQuerySlot(owner, deadline))) return [];
  const startedAtMs = Date.now();
  const timeout = Math.min(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, Math.floor(deadline - startedAtMs));
  if (timeout < 1) return [];
  const request = queryWindowsProcesses(undefined, timeout, options)
    .then((parsed) => (parsed?.complete ? parsed.identities : []))
    .finally(() => {
      if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
    });
  windowsProcessListInFlight = { promise: request, startedAtMs };
  return await beforeDeadline(owner ? trackQuery(owner, request) : request, deadline, []);
}
