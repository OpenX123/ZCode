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

async function runExclusiveQuery<T>(
  owner: object,
  deadline: number,
  start: () => Promise<T>,
  fallback: T,
): Promise<T> {
  while (Date.now() < deadline) {
    const previous = queryFlights.get(owner);
    if (previous) {
      if (
        !(await beforeDeadline(
          previous.then(() => true),
          deadline,
          false,
        ))
      )
        return fallback;
      continue;
    }
    // 检查与预留必须在同一同步段完成；空闲 boolean 跨 await 会让两个入口同时启动。
    let release!: () => void;
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryFlights.set(owner, physical);
    const finish = () => {
      if (queryFlights.get(owner) === physical) queryFlights.delete(owner);
      release();
    };
    try {
      const request = start();
      // 逻辑 deadline 只结束调用方等待；只有本 token 的物理完成可以归还占用。
      void request.then(finish, finish);
      return await beforeDeadline(request, deadline, fallback);
    } catch (error) {
      finish();
      throw error;
    }
  }
  return fallback;
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
        resolve(parseWindowsProcessList(stdout, filter === undefined));
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
  isIdentityGone: (identity: ProcessIdentity) => boolean = () => false,
): Promise<ProcessTreeOwnershipResolution> {
  const currentIdentities: ProcessIdentity[] = [];
  const goneIdentities: ProcessIdentity[] = [];
  const unknownIdentities: ProcessIdentity[] = [];
  for (let index = 0; index < identities.length; index += 64) {
    let batch = identities.slice(index, index + 64);
    if (!isActive()) {
      unknownIdentities.push(...identities.slice(index));
      break;
    }
    // 等占用期间出现的明确退出也会撤销查询资格，不能由下一批重新取得旧身份 M。
    goneIdentities.push(...batch.filter(isIdentityGone));
    batch = batch.filter((identity) => !isIdentityGone(identity));
    if (batch.length === 0) continue;
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
    const parsed = await runExclusiveQuery(
      owner,
      deadline,
      () => {
        // 真正取得 token 后重读退出事实和截止；排队不能复用旧的准入结论。
        goneIdentities.push(...batch.filter(isIdentityGone));
        batch = batch.filter((identity) => !isIdentityGone(identity));
        const timeout = Math.floor(deadline - Date.now());
        if (!isActive() || batch.length === 0 || timeout < 1) return Promise.resolve(undefined);
        return queryWindowsProcesses(
          batch.map((identity) => identity.pid),
          timeout,
          options,
        );
      },
      undefined,
    );
    if (batch.length === 0) continue;
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
  const read = (): Promise<readonly ProcessIdentity[]> => {
    const spawn = options.ownedProcessStartedAtMs;
    // 共享全表同样先取得该 owner 的 token，不能覆盖它尚未结束的定向查询占用。
    if (
      windowsProcessListInFlight &&
      (spawn === undefined || spawn < windowsProcessListInFlight.startedAtMs)
    )
      return windowsProcessListInFlight.promise;
    const startedAtMs = Date.now();
    const timeout = Math.min(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, Math.floor(deadline - startedAtMs));
    if (timeout < 1) return Promise.resolve([]);
    const request = queryWindowsProcesses(undefined, timeout, options)
      .then((parsed) => (parsed?.complete ? parsed.identities : []))
      .finally(() => {
        if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
      });
    windowsProcessListInFlight = { promise: request, startedAtMs };
    return request;
  };
  return await (owner
    ? runExclusiveQuery(owner, deadline, read, [])
    : beforeDeadline(read(), deadline, []));
}
