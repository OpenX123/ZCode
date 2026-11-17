import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const WINDOWS_START_TIME_PREFIX = "windows-utc-100ns:";

let windowsProcessListCache:
  | { identities: readonly ProcessIdentity[]; startedAtMs: number }
  | undefined;

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePosixProcessList(stdout: string, includeCommand: boolean): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const [pidText, parentPidText, processGroupIdText] = fields;
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const processGroupId = parsePositiveInteger(processGroupIdText);
    const lstart = fields.slice(3, 8).join(" ");
    const command = includeCommand ? fields.slice(8).join(" ") : "";
    // Darwin 的 ps 只暴露秒级 lstart；追加完整 command 作为复用校验熵。
    // Linux 随后会用 /proc start ticks 覆盖该值。
    const startTime = includeCommand ? `${lstart}|command:${command}` : lstart;
    if (pid === undefined || parentPid === undefined || !processGroupId || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, processGroupId, startTime });
  }
  return identities;
}

export function isWindowsPid(pid: unknown, allowZero = false): pid is number {
  return (
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid >= (allowZero ? 0 : 1) &&
    pid <= 4_294_967_295
  );
}

export function normalizeWindowsStartTime(raw: string | undefined): string | undefined {
  if (!raw || !/^(0|[1-9]\d*)$/u.test(raw)) return undefined;
  const ticks = BigInt(raw);
  if (ticks > 3_155_378_975_999_999_999n) return undefined;
  return `${WINDOWS_START_TIME_PREFIX}${ticks - DOTNET_UNIX_EPOCH_TICKS}`;
}

export function parseWindowsCreationTicks(startTime: string): bigint | undefined {
  if (!startTime.startsWith(WINDOWS_START_TIME_PREFIX)) return undefined;
  const raw = startTime.slice(WINDOWS_START_TIME_PREFIX.length);
  if (!/^(0|-?[1-9]\d*)$/u.test(raw)) return undefined;
  const ticks = BigInt(raw);
  const dotNetTicks = ticks + DOTNET_UNIX_EPOCH_TICKS;
  return dotNetTicks >= 0n && dotNetTicks <= 3_155_378_975_999_999_999n ? ticks : undefined;
}

export function parseWindowsProcessList(stdout: string): {
  identities: ProcessIdentity[];
  complete: boolean;
} {
  const identities: ProcessIdentity[] = [];
  let complete = true;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const [pidText, parentPidText, rawStartTime] = fields;
    const pid = /^(0|[1-9]\d*)$/u.test(pidText ?? "") ? Number(pidText) : NaN;
    if (!isWindowsPid(pid)) {
      complete = false;
      continue;
    }
    const parentPid = /^(0|[1-9]\d*)$/u.test(parentPidText ?? "") ? Number(parentPidText) : NaN;
    // 不丢弃坏中间节点，否则它的后代可能经另一条歧义边被重新认领。
    identities.push({
      parentPid: isWindowsPid(parentPid, true) ? parentPid : -1,
      pid,
      startTime: fields.length === 3 ? (normalizeWindowsStartTime(rawStartTime) ?? "") : "",
    });
  }
  return { identities, complete };
}

export function isWindowsLifecycleBoundary(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function collectWindowsSnapshotIdentities(
  rootPid: number,
  processList: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  rootExited: boolean,
): ProcessIdentity[] {
  if (!isWindowsPid(rootPid)) return [];
  const byPid = new Map<number, ProcessIdentity[]>();
  for (const identity of processList)
    byPid.set(identity.pid, [...(byPid.get(identity.pid) ?? []), identity]);
  const rootRows = byPid.get(rootPid) ?? [];
  const startedAt = options.ownedProcessStartedAtMs;
  const exitedAt = options.ownedProcessExitedAtMs ?? options.resolveOwnedProcessExitedAtMs?.();
  // 真实 exit 已记录时，即使 ChildProcess 的投影状态尚未更新，也不能信任同 PID 新行。
  rootExited = rootExited || exitedAt !== undefined;
  if (
    rootExited &&
    (!isWindowsLifecycleBoundary(startedAt) ||
      !isWindowsLifecycleBoundary(exitedAt) ||
      startedAt >= exitedAt)
  )
    return [];
  const root = rootRows.length === 1 ? rootRows[0] : undefined;
  const rootTicks = root ? parseWindowsCreationTicks(root.startTime) : undefined;
  const isCyclic = (pid: number) => {
    const seen = new Set<number>();
    while (byPid.get(pid)?.length === 1) {
      if (seen.has(pid)) return true;
      seen.add(pid);
      pid = byPid.get(pid)![0]!.parentPid;
    }
    return false;
  };
  // root 自身参与环时不能作为信任锚；环内与依赖环的分支均不能认领。
  if (!rootExited && isCyclic(rootPid)) return [];
  if (
    !rootExited &&
    (!root ||
      rootTicks === undefined ||
      !isWindowsPid(root.parentPid, true) ||
      (startedAt !== undefined &&
        (!isWindowsLifecycleBoundary(startedAt) || rootTicks < BigInt(startedAt) * 10_000n)))
  )
    return [];
  const accepted: ProcessIdentity[] = rootExited ? [] : [root!];
  const visit = (parentPid: number, parentTicks: bigint, path: Set<number>) => {
    for (const rows of byPid.values()) {
      if (rows.length !== 1) continue;
      const identity = rows[0]!;
      if (
        identity.parentPid !== parentPid ||
        path.has(identity.pid) ||
        identity.pid === rootPid ||
        (!rootExited && isCyclic(identity.pid))
      )
        continue;
      const ticks = parseWindowsCreationTicks(identity.startTime);
      if (
        ticks === undefined ||
        ticks < parentTicks ||
        (rootExited && ticks >= BigInt(exitedAt!) * 10_000n)
      )
        continue;
      accepted.push(identity);
      visit(identity.pid, ticks, new Set([...path, identity.pid]));
    }
  };
  visit(rootPid, rootExited ? BigInt(startedAt!) * 10_000n : rootTicks!, new Set([rootPid]));
  return accepted;
}

function readPosixProcessList(options: ProcessTreeTerminatorOptions): ProcessIdentity[] {
  const includeCommand = process.platform === "darwin";
  const result = spawnSync(
    "ps",
    includeCommand
      ? ["-axo", "pid=,ppid=,pgid=,lstart=,command="]
      : ["-eo", "pid=,ppid=,pgid=,lstart="],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
  );
  if (result.error) {
    warn(options, "查询 runtime 后代进程失败（进程表查询）:", result.error);
    return [];
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    warn(options, `查询 runtime 后代进程失败（进程表超时） signal=${result.signal}`);
    return [];
  }
  if (result.status !== 0 || !result.stdout) {
    warn(options, `查询 runtime 后代进程失败（进程表查询） status=${result.status ?? "unknown"}`);
    return [];
  }
  return parsePosixProcessList(result.stdout, includeCommand);
}

function readWindowsProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  if (
    windowsProcessListCache &&
    (options.ownedProcessStartedAtMs === undefined ||
      options.ownedProcessStartedAtMs < windowsProcessListCache.startedAtMs)
  ) {
    return windowsProcessListCache.identities;
  }
  const startedAtMs = Date.now();
  const timeout = Math.min(
    PROCESS_LOOKUP_TIMEOUT_MS,
    options.windowsCleanupDeadlineAtMs === undefined
      ? PROCESS_LOOKUP_TIMEOUT_MS
      : Math.floor(options.windowsCleanupDeadlineAtMs - startedAtMs),
  );
  if (timeout < 1) return [];
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
    ],
    {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    warn(
      options,
      `查询 Windows runtime 进程表失败 status=${result.status ?? "unknown"}:`,
      result.error ?? result.stderr,
    );
    return [];
  }
  if (
    options.windowsCleanupDeadlineAtMs !== undefined &&
    Date.now() >= options.windowsCleanupDeadlineAtMs
  )
    return [];
  const parsed = parseWindowsProcessList(result.stdout);
  if (!parsed.complete) return [];
  const identities = parsed.identities;
  const cache = { identities, startedAtMs };
  windowsProcessListCache = cache;
  // 同一轮 app quit 会同步抓取多个 workspace，复用同一份带 CreationDate 的系统进程表；
  // 下个 microtask 立即失效，避免稍后的 restart/quit 把 PID 复用误判成旧进程。
  queueMicrotask(() => {
    if (windowsProcessListCache === cache) {
      windowsProcessListCache = undefined;
    }
  });
  return identities;
}

function readProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  return process.platform === "win32"
    ? readWindowsProcessList(options)
    : readPosixProcessList(options);
}

function refineLinuxProcessIdentity(identity: ProcessIdentity): ProcessIdentity | undefined {
  if (process.platform !== "linux") {
    return identity;
  }
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    // /proc/<pid>/stat 的 field 22 是自 boot 起的启动 tick；精度高于 ps lstart
    // 的秒级时间，PID 在同一秒被复用时也不会被误认成旧 runtime 成员。
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const parentPid = parseNonNegativeInteger(fieldsAfterCommand[1]);
    const processGroupId = parsePositiveInteger(fieldsAfterCommand[2]);
    const startTimeTicks = fieldsAfterCommand[19];
    if (
      parentPid === undefined ||
      !processGroupId ||
      !startTimeTicks ||
      parentPid !== identity.parentPid ||
      processGroupId !== identity.processGroupId
    ) {
      // ps 与 /proc 两次读取间发生 PID 复用/reparent 时，不能拼出混合身份。
      return undefined;
    }
    return {
      ...identity,
      parentPid,
      processGroupId,
      startTime: `linux-ticks:${startTimeTicks}`,
    };
  } catch {
    return undefined;
  }
}

function refineProcessIdentities(identities: readonly ProcessIdentity[]): ProcessIdentity[] {
  if (process.platform !== "linux") {
    return [...identities];
  }
  return identities
    .map((identity) => refineLinuxProcessIdentity(identity))
    .filter((identity): identity is ProcessIdentity => identity !== undefined);
}

function collectDescendantIdentitiesFromProcessList(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return descendants;
}

export function filterCurrentProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (identities.length === 0) {
    return [];
  }
  if (process.platform === "win32") {
    const current: ProcessIdentity[] = [];
    for (let index = 0; index < identities.length; index += 64) {
      const batch = identities.slice(index, index + 64);
      if (batch.some((identity) => !isWindowsPid(identity.pid))) continue;
      const timeout = Math.min(
        PROCESS_LOOKUP_TIMEOUT_MS,
        options.windowsCleanupDeadlineAtMs === undefined
          ? PROCESS_LOOKUP_TIMEOUT_MS
          : Math.floor(options.windowsCleanupDeadlineAtMs - Date.now()),
      );
      if (timeout < 1) break;
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "${batch.map((identity) => `ProcessId = ${identity.pid}`).join(" OR ")}" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
        ],
        { encoding: "utf8", timeout, windowsHide: true },
      );
      if (
        result.error ||
        result.status !== 0 ||
        (options.windowsCleanupDeadlineAtMs !== undefined &&
          Date.now() >= options.windowsCleanupDeadlineAtMs)
      )
        continue;
      const parsed = parseWindowsProcessList(result.stdout ?? "");
      if (
        !parsed.complete ||
        parsed.identities.some((identity) => !batch.some((target) => target.pid === identity.pid))
      )
        continue;
      for (const target of batch) {
        const rows = parsed.identities.filter((identity) => identity.pid === target.pid);
        if (
          rows.length === 1 &&
          rows[0]!.startTime === target.startTime &&
          parseWindowsCreationTicks(target.startTime) !== undefined
        )
          current.push(target);
      }
    }
    return current;
  }
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    refineProcessIdentities(
      readProcessList(options).filter((identity) => trackedPids.has(identity.pid)),
    ).map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return (
      current?.startTime === identity.startTime &&
      (identity.processGroupId === undefined || current.processGroupId === identity.processGroupId)
    );
  });
}

export function captureProcessTreeSnapshot(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (child.pid == null) {
    return undefined;
  }
  const processList = readProcessList(options);
  if (process.platform === "win32") {
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
          identities,
          descendantPids: identities
            .filter((identity) => identity.pid !== child.pid)
            .map((identity) => identity.pid),
        };
  }
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  if (!rootIdentity) {
    // 没有创建标识的 rootPid 不能形成进程所有权；返回半截快照会让
    // 延迟回收在 PID 复用后重新沿裸 root PID 认领无关进程树。
    return undefined;
  }
  const descendantIdentities = collectDescendantIdentitiesFromProcessList(child.pid, processList);
  // POSIX detached root 是自己进程组的 leader；若它在 ps 扫描期间退出，
  // 后代会被 reparent，单靠 PPID 链会漏掉仍属于该 owned PGID 的进程。仅在
  // PGID === root PID 时合并同组成员，避免把普通 child 所在的宿主进程组纳入快照。
  const ownedProcessGroupIdentities =
    process.platform !== "win32" && rootIdentity.processGroupId === child.pid
      ? processList.filter((identity) => identity.processGroupId === child.pid)
      : [];
  const snapshotCandidates = new Map(
    [rootIdentity, ...descendantIdentities, ...ownedProcessGroupIdentities].map((identity) => [
      identity.pid,
      identity,
    ]),
  );
  const identities = refineProcessIdentities([...snapshotCandidates.values()]);
  if (!identities.some((identity) => identity.pid === child.pid)) {
    return undefined;
  }
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureProcessGroupSnapshot(
  processGroupId: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return undefined;
  }
  // POSIX detached Agent 的 root 可能先于同组 MCP/工具进程退出，
  // 此时 PPID 已经变化，但内核会在最后一个成员退出前保留原 PGID。只在 cleanup
  // 边界按 Host spawn 时拥有的 PGID 查询，避免把进程表扫描带入协议消息热路径。
  const identities = refineProcessIdentities(
    readProcessList(options).filter((identity) => identity.processGroupId === processGroupId),
  );
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid: processGroupId,
    descendantPids: identities
      .filter((identity) => identity.pid !== processGroupId)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureExitedRootDescendantsSnapshot(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    process.platform !== "win32" ||
    !isWindowsPid(rootPid) ||
    !isWindowsLifecycleBoundary(startedAtMs) ||
    !isWindowsLifecycleBoundary(exitedAtMs) ||
    startedAtMs >= exitedAtMs
  ) {
    return undefined;
  }
  // Windows Win32_Process 会保留创建者 ParentProcessId，即使 CLI root
  // 已经退出。裸 ParentProcessId 会在 PID 复用后误认领无关进程，因此候选成员的
  // CreationDate 还必须落在 Host 记录的 root 生命周期内；后续 force 再按同一
  // CreationDate 复核，不能向已经复用的 descendant PID 发信号。
  const identities = collectWindowsSnapshotIdentities(
    rootPid,
    readProcessList(options),
    options,
    true,
  );
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid,
    descendantPids: identities.map((identity) => identity.pid),
    identities,
  };
}
