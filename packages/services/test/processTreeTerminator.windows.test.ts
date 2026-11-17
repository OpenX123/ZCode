import { ChildProcess as NativeChildProcess, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, spawnSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));

import {
  captureProcessTreeSnapshotAsync,
  captureProcessTreeSnapshot,
  captureExitedRootDescendantsSnapshot,
  filterCurrentProcessIdentitiesAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "@zcode/services/process/processTreeTerminator";
import { filterCurrentProcessIdentities } from "../src/process/processTreeSnapshot.js";
import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";
import { defaultWindowsTaskkillRunner } from "../src/process/windowsTaskkillRunner.js";
import {
  hasWindowsProcessQueryInFlight,
  readWindowsProcessListAsync,
  verifyWindowsProcessIdentitiesAsync,
} from "../src/process/windowsProcessListAsync.js";

const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;

let targetedPowerShellResult: string | undefined;
let targetedPowerShellResultsByPid: Map<number, string>;
let powershellResult: string;
let powershellError: Error | null;
let powershellDelayMs: number;
let targetedPowerShellUsesConfiguredTimeout: boolean;
let onPowerShellQuery: (() => void) | undefined;
let alivePids: Set<number>;
let taskkillRemovesOnGraceful: boolean;
let targetedDelayMs: number;
let taskkillEffect: number[];
let queryEvents: { pids: number[]; started: number; timeout: number }[];
let activeQueries: number;
let peakQueries: number;
let taskkillEnabled: boolean;

function fakeChild(pid = 4242) {
  return Object.assign(new NativeChildProcess(), {
    spawnfile: "mock-owned-agent.exe",
    _handle: { kill: vi.fn() },
    exitCode: null as number | null,
    pid,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as ChildProcess;
}

function taskkillCommands() {
  return execFileMock.mock.calls
    .filter(([command]) => command === "taskkill")
    .map(([, args]) => ({
      pid: Number(args[1]),
      force: args.includes("/F"),
      args,
    }));
}

function powershellIdentity(pid: number, parentPid: number): string {
  return powershellIdentityAt(pid, parentPid, Date.UTC(2026, 6, 24, 11, 0, 0));
}

function powershellIdentityAt(pid: number, parentPid: number, utcMilliseconds: number): string {
  const ticks = DOTNET_UNIX_EPOCH_TICKS + BigInt(utcMilliseconds) * 10_000n;
  return `${pid} ${parentPid} ${ticks}\n`;
}

describe("terminateProcessTree Windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 24, 12, 0, 0)));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    alivePids = new Set([4242]);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (alivePids.has(Number(pid))) return true;
      throw Object.assign(new Error("process not found"), { code: "ESRCH" });
    });
    targetedPowerShellResult = undefined;
    targetedPowerShellResultsByPid = new Map();
    powershellResult = powershellIdentity(4242, 1);
    powershellError = null;
    powershellDelayMs = 0;
    targetedPowerShellUsesConfiguredTimeout = false;
    onPowerShellQuery = undefined;
    taskkillRemovesOnGraceful = false;
    targetedDelayMs = 0;
    taskkillEffect = [];
    queryEvents = [];
    activeQueries = 0;
    peakQueries = 0;
    taskkillEnabled = true;
    spawnMock.mockReset().mockImplementation(() => {
      throw new Error("真实 spawn 未放行");
    });
    spawnSyncMock.mockReset().mockImplementation((command: string, args: string[]) => {
      if (command !== "powershell.exe") throw new Error(`未放行 spawnSync: ${command}`);
      const pids = [...args.join(" ").matchAll(/ProcessId = (\d+)/gu)].map((match) =>
        Number(match[1]),
      );
      return {
        status: 0,
        stdout:
          pids.length === 0
            ? powershellResult
            : powershellResult
                .split("\n")
                .filter((line) => pids.includes(Number(line.split(" ")[0])))
                .join("\n"),
      };
    });
    execFileMock
      .mockReset()
      .mockImplementation(
        (
          command: string,
          args: string[],
          options: { timeout?: number },
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (command === "powershell.exe") {
            onPowerShellQuery?.();
            const targeted = args.some((arg) => arg.includes("ProcessId ="));
            const targetedPids = [...args.join(" ").matchAll(/ProcessId = (\d+)/gu)].map((match) =>
              Number(match[1]),
            );
            const resultAtInvocation = targeted
              ? (targetedPowerShellResult ??
                targetedPids
                  .map(
                    (pid) =>
                      targetedPowerShellResultsByPid.get(pid) ??
                      powershellResult
                        .split("\n")
                        .filter((line) => Number(line.split(" ")[0]) === pid)
                        .join("\n"),
                  )
                  .join("\n"))
              : powershellResult;
            queryEvents.push({
              pids: targetedPids,
              started: Date.now(),
              timeout: options.timeout ?? 0,
            });
            activeQueries += 1;
            peakQueries = Math.max(peakQueries, activeQueries);
            const errorAtInvocation = powershellError;
            const reply = () => {
              activeQueries -= 1;
              callback(errorAtInvocation, resultAtInvocation, "");
            };
            const delayMs =
              targeted && targetedPowerShellUsesConfiguredTimeout
                ? Math.max((options.timeout ?? 0) - 1, 0)
                : targeted
                  ? targetedDelayMs
                  : powershellDelayMs;
            if (delayMs > 0) setTimeout(reply, delayMs);
            else reply();
          } else if (command === "taskkill") {
            const pid = Number(args[1]);
            const affected = new Set([pid]);
            if (args.includes("/T")) {
              for (let changed = true; changed; ) {
                changed = false;
                for (const line of powershellResult.split("\n")) {
                  const [candidate, parent] = line.split(" ").map(Number);
                  if (affected.has(parent) && !affected.has(candidate)) {
                    affected.add(candidate);
                    changed = true;
                  }
                }
              }
            }
            taskkillEffect.push(...affected);
            if (taskkillEnabled && (taskkillRemovesOnGraceful || args.includes("/F"))) {
              for (const affectedPid of affected) alivePids.delete(affectedPid);
            }
            callback(null, "", "");
          } else throw new Error(`未放行 execFile: ${command}`);
          return {};
        },
      );
  });

  afterEach(() => {
    expect(taskkillCommands().every(({ args }) => !args.includes("/T"))).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Windows 进程快照直接使用 PowerShell/CIM", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    const snapshot = await captureProcessTreeSnapshotAsync(child);

    expect(snapshot?.rootPid).toBe(4242);
    expect(execFileMock.mock.calls.filter(([command]) => command === "wmic.exe")).toHaveLength(0);
    expect(
      execFileMock.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toHaveLength(1);
  });

  it.each(["async", "sync"])("W18 %s 首次全表忽略合法Idle行并exact回收R/C/G", async (mode) => {
    const child = fakeChild();
    powershellResult =
      "0 0 639303123216689210\n" +
      powershellIdentity(4242, 1) +
      powershellIdentity(5000, 4242) +
      powershellIdentity(5001, 5000);
    alivePids = new Set([4242, 5000, 5001]);
    const snapshot =
      mode === "sync"
        ? captureProcessTreeSnapshot(child)
        : await captureProcessTreeSnapshotAsync(child);
    expect(snapshot?.identities.map(({ pid }) => pid)).toEqual([4242, 5000, 5001]);
    const result = terminateProcessTreeAndWait(child, { snapshot });
    await vi.advanceTimersByTimeAsync(4250);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([4242, 5000, 5001]);
    expect(taskkillEffect).not.toContain(0);
    expect(alivePids.size).toBe(0);
    expect(queryEvents.filter(({ pids }) => pids.length === 0)).toHaveLength(
      mode === "sync" ? 0 : 1,
    );
    expect(spawnSyncMock).toHaveBeenCalledTimes(mode === "sync" ? 1 : 0);
  });

  it.each([
    "0 0 639303123216689210\n",
    "0 0 639303123216689210\n4242 1 639204876000000000\n",
    "0 1 639303123216689210\n",
    "0 0 malformed\n",
    "0 0 639303123216689210 extra\n",
    "-1 0 639303123216689210\n",
  ])("W18 定向坏行整批unknown且不产生gone：%s", async (response) => {
    const identities = [
      { pid: 4242, parentPid: 1, startTime: "windows-utc-100ns:17848908000000000" },
    ];
    targetedPowerShellResult = response;
    const result = await verifyWindowsProcessIdentitiesAsync(identities, Date.now() + 750, {}, {});
    expect(result.currentIdentities).toEqual([]);
    expect(result.goneIdentities).toEqual([]);
    expect(result.unknownIdentities).toEqual(identities);
    expect(taskkillCommands()).toEqual([]);
  });

  it.each(["async", "sync"])("W18 %s 全表不能忽略非规范Idle或坏PID行", async (mode) => {
    for (const row of [
      "0 1 639303123216689210",
      "00 0 639303123216689210",
      "0 0 malformed",
      "0 0 3155378976000000000",
      "0 0 639303123216689210 extra",
      "0 0",
      "bad 0 639303123216689210",
      "4294967296 0 639303123216689210",
    ]) {
      powershellResult = row + "\n" + powershellIdentity(4242, 1);
      const snapshot =
        mode === "sync"
          ? captureProcessTreeSnapshot(fakeChild())
          : await captureProcessTreeSnapshotAsync(fakeChild());
      expect(snapshot).toBeUndefined();
      await Promise.resolve();
    }
    expect(taskkillCommands()).toEqual([]);
  });

  it.each([false, true])("W18 定向Idle响应mixed=%s保留整批remaining且不发信号", async (mixed) => {
    const child = fakeChild();
    child.exitCode = 0;
    const identities = [
      { pid: 5000, parentPid: 4242, startTime: "windows-utc-100ns:17848908000000000" },
      { pid: 5001, parentPid: 5000, startTime: "windows-utc-100ns:17848908000000000" },
    ];
    alivePids = new Set([5000, 5001]);
    targetedPowerShellResult =
      "0 0 639303123216689210\n" +
      (mixed ? powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000) : "");
    const result = terminateProcessTreeAndWait(child, {
      snapshot: { rootPid: 4242, descendantPids: [5000, 5001], identities },
    });
    await vi.advanceTimersByTimeAsync(4250);
    await expect(result).resolves.toEqual({ remainingPids: [5000, 5001] });
    expect(taskkillCommands()).toEqual([]);
    expect(taskkillEffect).toEqual([]);
    expect(alivePids).toEqual(new Set([5000, 5001]));
  });

  it("非等待式回收到 force deadline 后不使用旧快照强杀 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    // 修复原因：Node exit 回调可能晚于 OS 退出及 PID 复用；deadline 时没有新的
    // CreationDate 复核，就不能根据旧快照向裸 root PID 发送 /F。
    targetedPowerShellResult = powershellIdentityAt(4242, 1, Date.now());
    terminateProcessTree(child, { forceAfterMs: 20 });
    await vi.advanceTimersByTimeAsync(20);

    expect(taskkillCommands().filter(({ pid, force }) => pid === 4242 && force)).toEqual([]);
  });

  it("force 前直接使用 PowerShell 定向复核 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 4242")]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 定向复核为 PowerShell 保留完整预算", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    targetedPowerShellUsesConfiguredTimeout = true;
    powershellResult = powershellIdentity(4242, 1);

    terminateProcessTree(child, { forceAfterMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 4242")]),
      expect.objectContaining({ timeout: 750, windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 定向复核失败时仅对受管 live root 使用句柄兜底", async () => {
    const child = fakeChild();
    alivePids = new Set([4242, 5000]);
    powershellError = Object.assign(new Error("simulated targeted CIM timeout"), {
      code: "ETIMEDOUT",
    });
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) => {
      if (force && pid === 4242) {
        alivePids.delete(pid);
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }
      return Promise.resolve({});
    });

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          { parentPid: 1, pid: 4242, startTime: "windows-utc-100ns:17848908000000000" },
          { parentPid: 4242, pid: 5000, startTime: "windows-utc-100ns:17848908000000000" },
        ],
      },
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1000);

    // 安全契约：受管 ChildProcess 的 live root 句柄是 root-only 所有权证据；CIM
    // 定向复核失败时仍可收口 root，但不得把未复核后代加入显式 /F 目标。
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).not.toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(130);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000] });
  });

  it("graceful 挂起时 force 会强杀本次仍匹配的 root 与已验证后代", async () => {
    const child = fakeChild();
    alivePids = new Set([4242, 5000]);
    powershellResult = `${powershellIdentity(4242, 1)}${powershellIdentity(5000, 4242)}`;
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) =>
      force
        ? Promise.resolve().then(() => {
            alivePids.delete(pid);
            if (pid === 4242) {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            }
            return {};
          })
        : new Promise<Record<string, never>>(() => {}),
    );

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1000);

    // Bug 回归：旧 deadlineSnapshotOnly 分支只保留 root，导致已验证后代永远没有 /F flight。
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });
    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
  });

  it("force 前后代 PID 已复用时跳过该 PID 但继续收口匹配的 root", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult = `${powershellIdentity(4242, 1)}${powershellIdentity(5000, 4242)}`;
    targetedPowerShellResultsByPid.set(5000, powershellIdentityAt(5000, 1, Date.now()));
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) =>
      force
        ? Promise.resolve().then(() => {
            alivePids.delete(pid);
            if (pid === 4242) {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            }
            return {};
          })
        : new Promise<Record<string, never>>(() => {}),
    );

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).not.toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 5000")]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    // 完整成功查询证明原创建身份已经换代：旧成员 gone，新身份不进入信号或 remaining。
    await vi.advanceTimersByTimeAsync(880);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
  });

  it("force timer 先于 exit 回调且 PID 已复用时不强杀新 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    targetedPowerShellResult = powershellIdentityAt(4242, 1, Date.now());

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(queryEvents.filter(({ pids }) => pids.length > 0)).toHaveLength(1);
    expect(taskkillCommands().filter(({ pid, force }) => pid === 4242 && force)).toEqual([]);
  });

  it("PowerShell 全量快照与身份过滤保持同一进程创建身份", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    const snapshot = await captureProcessTreeSnapshotAsync(child);
    expect(await filterCurrentProcessIdentitiesAsync(snapshot!.identities, {})).toEqual(
      snapshot!.identities,
    );

    const secondSnapshot = await captureProcessTreeSnapshotAsync(child);
    expect(await filterCurrentProcessIdentitiesAsync(secondSnapshot!.identities, {})).toEqual(
      secondSnapshot!.identities,
    );
  });

  it("PowerShell 查询耗尽预算后 force 复用快照且不重复查询", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    const snapshot = await captureProcessTreeSnapshotAsync(child);
    const fullQueryCount = execFileMock.mock.calls.filter(
      ([command, args]) =>
        command === "powershell.exe" &&
        !(args as string[]).some((arg) => arg.includes("ProcessId =")),
    ).length;

    targetedDelayMs = 100;
    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot,
      waitAfterForceMs: 30,
      windowsTaskkillTimeoutMs: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(taskkillCommands().filter(({ pid, force }) => pid === 4242 && force)).toEqual([]);
    expect(
      execFileMock.mock.calls.filter(
        ([command, args]) =>
          command === "powershell.exe" &&
          !(args as string[]).some((arg) => arg.includes("ProcessId =")),
      ),
    ).toHaveLength(fullQueryCount);
    await vi.advanceTimersByTimeAsync(31);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [4242] });
  });

  it("进程表快照查询本身也受 transport 全链路绝对 deadline 约束", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellDelayMs = 50;
    let settled = false;

    const snapshotPromise = captureProcessTreeSnapshotAsync(child, {
      windowsCleanupDeadlineAtMs: Date.now() + 40,
    });
    void snapshotPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    // 旧实现会继续等待 PowerShell 到 60ms；绝对 deadline 到达后必须立即退化为
    // unavailable，让 transport 继续进入有界的 fail-closed 收口。
    expect(settled).toBe(true);
    await expect(snapshotPromise).resolves.toBeUndefined();
    // 让被 absolute-deadline race 截断的底层 mock 查询完成，避免模块级共享 flight 污染后续用例。
    await vi.advanceTimersByTimeAsync(20);
  });

  it("不为晚于共享查询启动的新 root 复用过期进程表", async () => {
    const firstChild = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    const secondChild = {
      exitCode: null,
      pid: 6000,
      signalCode: null,
    } as ChildProcess;
    powershellDelayMs = 20;

    powershellResult = powershellIdentityAt(4242, 1, Date.now());
    const firstSnapshotPromise = captureProcessTreeSnapshotAsync(firstChild, {
      ownedProcessStartedAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(1);
    powershellResult = powershellIdentityAt(6000, 1, Date.now());
    const secondSnapshotPromise = captureProcessTreeSnapshotAsync(secondChild, {
      ownedProcessStartedAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(firstSnapshotPromise).resolves.toMatchObject({ rootPid: 4242 });
    await expect(secondSnapshotPromise).resolves.toMatchObject({ rootPid: 6000 });
  });

  it("等待 graceful taskkill flight 与稍后投递的 exit 后再判定完成", async () => {
    const child = fakeChild();
    let completeTaskkill: (() => void) | undefined;
    const windowsTaskkillRunner = vi.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          completeTaskkill = () => {
            alivePids.delete(4242);
            resolve({});
          };
        }),
    );
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // Bug 回归：旧 waiter 在 graceful taskkill 尚未 settle 时按固定 force-wait 窗口
    // 报 remaining PID；真实进程可能只晚几个毫秒投递 ChildProcess exit。
    await vi.advanceTimersByTimeAsync(31);
    expect(result).toBeUndefined();

    completeTaskkill?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    setTimeout(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }, 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 4242,
      timeoutMs: 100,
    });
  });

  it("root 查询期间退出并复用 PID 时不认领新进程后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult =
      powershellIdentityAt(4242, 1, Date.UTC(2026, 6, 24, 11, 30, 0)) +
      powershellIdentityAt(5000, 4242, Date.UTC(2026, 6, 24, 11, 30, 0, 100));
    onPowerShellQuery = () => {
      child.exitCode = 0;
    };

    const snapshot = await captureProcessTreeSnapshotAsync(child, {
      ownedProcessStartedAtMs: Date.UTC(2026, 6, 24, 10, 0, 0),
    });
    expect(snapshot).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("root 查询期间退出且有可信 exit 时间时恢复并回收旧后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([5000]);
    taskkillRemovesOnGraceful = true;
    powershellResult = powershellIdentity(5000, 4242);
    const exitedAtMs = Date.UTC(2026, 6, 24, 11, 30, 0);
    onPowerShellQuery = () => {
      child.exitCode = 0;
    };

    const snapshot = await captureProcessTreeSnapshotAsync(child, {
      ownedProcessStartedAtMs: Date.UTC(2026, 6, 24, 10, 0, 0),
      resolveOwnedProcessExitedAtMs: () => exitedAtMs,
    });
    expect(snapshot?.identities.map((identity) => identity.pid)).toEqual([5000]);

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot,
      waitAfterForceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "5000", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("双后端查询失败时等待未验证 root 并明确报告残留", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;

    powershellResult = "";
    await expect(captureProcessTreeSnapshotAsync(child)).resolves.toBeUndefined();

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 20,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsTaskkillTimeoutMs: 20,
    });
    let result: Awaited<typeof resultPromise> | undefined;
    void resultPromise.then((value) => {
      result = value;
    });

    // 查询失败且没有任何已验证 identity 时，graceful/force targets 都为空；没有实际
    // taskkill 可以等待，因此 deadline 不应无条件预留 taskkill timeout。
    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual({ remainingPids: [4242] });
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("没有 taskkill 目标时使用 transport 剩余预算观察延迟正常退出", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsCleanupDeadlineAtMs: Date.now() + 1_000,
      windowsTaskkillTimeoutMs: 1000,
    });
    void resultPromise.then((value) => {
      result = value;
    });
    setTimeout(() => {
      alivePids.delete(4242);
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, 600);

    // Bug 回归：没有可安全发送 taskkill 的身份时，旧 waiter 会把 1s 绝对预算
    // 压缩为 waitAfterForceMs=30ms，把随后正常 code=0 的 exit 误报为残留。
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(570);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("纯观察窗口不突破 Local Host 四秒总上界", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsCleanupDeadlineAtMs: Date.now() + 1_000,
      windowsTaskkillTimeoutMs: 1000,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // 首次 cleanup 最坏 3.25s；最终重试只能再观察 750ms，必须在 Local Host
    // 的 4s 强制退出点前明确返回真实残留，不能把完整 1.25s retry 预算串行叠加。
    await vi.advanceTimersByTimeAsync(749);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [4242] });
  });

  it("未验证 root 仍有已验证目标时保留 taskkill deadline", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult += powershellIdentity(5000, 4242);
    const windowsTaskkillRunner = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 20,
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          {
            parentPid: 4242,
            pid: 5000,
            startTime: "windows-utc-100ns:17848908000000000",
          },
        ],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 20,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // 即使 root 不可验证，只要存在已验证后代，graceful taskkill 就是真实 flight；
    // 继续保留完整预算，不能在 force + grace 的 50ms 边界提前报告。
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000, 4242] });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 20,
    });
  });

  it("全链路绝对 deadline 会扣除进入 waiter 前已消耗的快照与 EOF 时间", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    const windowsTaskkillRunner = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [
          {
            parentPid: 1,
            pid: 4242,
            startTime: "windows-utc-100ns:17848908000000000",
          },
        ],
      },
      waitAfterForceMs: 30,
      // 模拟 snapshot + EOF 已经消耗 3,210ms：transport 的 3,250ms 全链路预算只剩 40ms。
      windowsCleanupDeadlineAtMs: Date.now() + 40,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    // 旧实现会在这里仍为 undefined，并把窗口错误延长到 130ms；断言必须快速失败，
    // 不能等待旧 deadline 导致 fake-timer 用例自身超时。
    expect(result).toEqual({ remainingPids: [4242] });
    await expect(resultPromise).resolves.toEqual(result);
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 27,
    });
  });

  describe.each(["async", "sync"] as const)("固定发现 %s", (mode) => {
    async function capture(child = fakeChild(), options = {}) {
      return mode === "sync"
        ? captureProcessTreeSnapshot(child, options)
        : await captureProcessTreeSnapshotAsync(child, options);
    }

    it("W01/W02/W03 拒绝旧PPID与中间父碰撞整枝，保留精确相等旁支", async () => {
      const tick = DOTNET_UNIX_EPOCH_TICKS + 10_000n * 1000n;
      powershellResult = `4242 1 ${tick}\n5000 4242 ${tick - 1n}\n5001 5000 ${tick + 10n}\n6000 4242 ${tick + 9000n}\n6001 6000 ${tick + 1000n}\n6002 6001 ${tick + 10000n}\n7000 4242 ${tick}\n7001 7000 ${tick + 1n}\n`;
      const snapshot = await capture();
      expect(snapshot?.identities.map(({ pid }) => pid)).toEqual([4242, 6000, 7000, 7001]);
      expect(snapshot?.identities.at(-1)?.startTime).toBe(`windows-utc-100ns:${10_000_001n}`);
      await vi.advanceTimersByTimeAsync(0);
      powershellResult = powershellResult.trim().split("\n").reverse().join("\n");
      expect((await capture())?.identities.map(({ pid }) => pid).sort((a, b) => a - b)).toEqual([
        4242, 6000, 7000, 7001,
      ]);
      alivePids = new Set([4242, 5000, 5001, 6000, 6001, 6002, 7000, 7001]);
      const result = terminateProcessTreeAndWait(fakeChild(), {
        snapshot,
        forceAfterMs: 20,
        windowsTaskkillTimeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(370);
      await expect(result).resolves.toEqual({ remainingPids: [] });
      expect(
        taskkillCommands()
          .filter(({ force }) => force)
          .map(({ pid }) => pid),
      ).toEqual([4242, 6000, 7000, 7001]);
      expect(alivePids).toEqual(new Set([5000, 5001, 6001, 6002]));
      for (const rejected of [5000, 5001, 6001, 6002])
        expect(taskkillEffect).not.toContain(rejected);
    });

    it("W02/W04 重复与坏中间节点不穿透，root歧义不形成快照", async () => {
      powershellResult +=
        powershellIdentity(5000, 4242) +
        powershellIdentity(5000, 4242) +
        powershellIdentity(5001, 5000) +
        "6000 4242 bad\n" +
        powershellIdentity(6001, 6000);
      expect((await capture())?.identities.map(({ pid }) => pid)).toEqual([4242]);
      await Promise.resolve();
      powershellResult += powershellIdentity(4242, 1);
      expect(await capture()).toBeUndefined();
    });

    it.each(["-1", "+1", "1.0", "1e3", "3155378976000000000", "", "bad"])(
      "W04 无歧义ticks拒绝 %s",
      async (ticks) => {
        powershellResult = `4242 1 ${ticks}\n`;
        expect(await capture()).toBeUndefined();
      },
    );

    it("W05 root时间早于可信spawn则拒绝", async () => {
      powershellResult = powershellIdentityAt(4242, 1, 999);
      expect(await capture(fakeChild(), { ownedProcessStartedAtMs: 1000 })).toBeUndefined();
    });

    it("W02 root在循环中时拒绝全部依赖分支", async () => {
      powershellResult =
        powershellIdentity(4242, 5000) +
        powershellIdentity(5000, 4242) +
        powershellIdentity(5001, 5000);
      expect(await capture()).toBeUndefined();
    });

    it("W06/W07 已退出root只恢复可信[spawn,exit)内逐边后代", async () => {
      const child = fakeChild();
      child.exitCode = 0;
      powershellResult =
        powershellIdentityAt(4242, 1, 1100) +
        powershellIdentityAt(5000, 4242, 1000) +
        powershellIdentityAt(5001, 5000, 1099) +
        powershellIdentityAt(5002, 5001, 1100);
      const options = { ownedProcessStartedAtMs: 1000, ownedProcessExitedAtMs: 1100 };
      const snapshot = await capture(child, options);
      expect(snapshot?.identities.map(({ pid }) => pid)).toEqual([5000, 5001]);
      expect(
        mode === "sync"
          ? captureExitedRootDescendantsSnapshot(4242, options)?.identities
          : snapshot?.identities,
      ).toEqual(snapshot?.identities);
    });

    it.each([
      [1000, 1000],
      [1100, 1000],
      [-1, 1000],
      [0.5, 1000],
      [0, Infinity],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ])("W07 无效生命周期 %s/%s不恢复", async (start, end) => {
      const child = fakeChild();
      child.exitCode = 0;
      powershellResult = powershellIdentityAt(5000, 4242, 900);
      expect(
        await capture(child, { ownedProcessStartedAtMs: start, ownedProcessExitedAtMs: end }),
      ).toBeUndefined();
    });
  });

  it("W08 sync快照到async过滤及默认exact force可组合", async () => {
    const child = fakeChild();
    alivePids.add(5000);
    powershellResult += powershellIdentity(5000, 4242);
    const snapshot = captureProcessTreeSnapshot(child)!;
    expect(await filterCurrentProcessIdentitiesAsync(snapshot.identities, {})).toEqual(
      snapshot.identities,
    );
    expect(filterCurrentProcessIdentities(snapshot.identities, {})).toEqual(snapshot.identities);
    expect(spawnSyncMock.mock.calls.at(-1)?.[1].join(" ")).toContain("-Filter");
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([4242, 5000]);
    expect(taskkillCommands().every(({ args }) => !args.includes("/T"))).toBe(true);
    expect(taskkillEffect).toEqual([4242, 5000]);
  });

  it.each([18, 64, 65, 129])("W13 %s固定成员每批最多64且物理串行", async (count) => {
    const child = fakeChild();
    powershellResult = Array.from({ length: count }, (_, index) =>
      powershellIdentity(4242 + index, index === 0 ? 1 : 4242),
    ).join("");
    alivePids = new Set(Array.from({ length: count }, (_, index) => 4242 + index));
    const snapshot = await captureProcessTreeSnapshotAsync(child);
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(
      queryEvents.filter(({ pids }) => pids.length > 0).map(({ pids }) => pids.length),
    ).toEqual(count <= 64 ? [count] : count === 65 ? [64, 1] : [64, 64, 1]);
    expect(peakQueries).toBe(1);
    expect(queryEvents.flatMap(({ pids }) => pids)).toEqual(
      Array.from({ length: count }, (_, index) => 4242 + index),
    );
    expect(taskkillCommands().filter(({ force }) => force)).toHaveLength(count);
  });

  it("W04/W14 初始root-exited过滤全unknown仍保留K与force机会，EPERM非gone", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    powershellResult = powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    alivePids = new Set([5000, 5001]);
    const snapshot = {
      rootPid: 4242,
      descendantPids: [5000, 5001],
      identities: [
        { pid: 5000, parentPid: 4242, startTime: "windows-utc-100ns:17848908000000000" },
        { pid: 5001, parentPid: 5000, startTime: "windows-utc-100ns:17848908000000000" },
      ],
    };
    powershellError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    targetedDelayMs = 750;
    let result: unknown;
    const pending = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 2000,
      windowsCleanupDeadlineAtMs: Date.now() + 3250,
      windowsTaskkillTimeoutMs: 1000,
    }).then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(750);
    expect(result).toBeUndefined();
    powershellError = null;
    targetedDelayMs = 0;
    await vi.advanceTimersByTimeAsync(2500);
    await pending;
    expect(result).toEqual({ remainingPids: [] });
    expect(
      queryEvents
        .filter(({ pids }) => pids.length > 0)
        .map(({ started }) => started - queryEvents[0]!.started),
    ).toEqual([0, 1250]);
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([5000, 5001]);
  });

  it("W04 查询unknown与EPERM在截止保留remaining且无信号", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const snapshot = {
      rootPid: 4242,
      descendantPids: [5000],
      identities: [{ pid: 5000, parentPid: 4242, startTime: "windows-utc-100ns:1" }],
    };
    powershellError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const warning = vi.fn();
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
      log: { warn: warning },
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [5000] });
    expect(taskkillCommands()).toEqual([]);
    expect(
      warning.mock.calls.some(([, message]) => String(message).includes("unresolved=5000")),
    ).toBe(true);
  });

  it("W09/W10/W15/W16 短窗口exact回收合法树且不触碰晚生或换代身份", async () => {
    const child = fakeChild();
    alivePids = new Set([4242, 5000, 5001, 6000, 7000]);
    powershellResult +=
      powershellIdentity(5000, 4242) +
      powershellIdentity(5001, 5000) +
      powershellIdentity(6000, 4242);
    const snapshot = await captureProcessTreeSnapshotAsync(child);
    powershellResult =
      powershellResult.replace(
        powershellIdentity(6000, 4242),
        powershellIdentityAt(6000, 4242, Date.now()),
      ) + powershellIdentity(7000, 4242);
    const start = Date.now();
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 150,
      windowsTaskkillTimeoutMs: 1000,
      windowsCleanupDeadlineAtMs: start + 1400,
    });
    await vi.advanceTimersByTimeAsync(1400);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(queryEvents.at(-1)?.timeout).toBe(575);
    expect(
      taskkillCommands()
        .filter(({ force }) => !force)
        .map(({ pid }) => pid),
    ).toEqual([4242]);
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([4242, 5000, 5001]);
    expect(taskkillEffect).not.toContain(6000);
    expect(taskkillEffect).not.toContain(7000);
    expect(alivePids).toEqual(new Set([6000, 7000]));
  });

  it("W11 已登记C/G合法reparent后仍exact回收", async () => {
    const child = fakeChild();
    alivePids = new Set([4242, 5000, 5001]);
    powershellResult += powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    const snapshot = await captureProcessTreeSnapshotAsync(child);
    child.exitCode = 0;
    alivePids.delete(4242);
    powershellResult = powershellIdentity(5000, 1) + powershellIdentity(5001, 1);
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(taskkillCommands().map(({ pid }) => pid)).toEqual([5000, 5001]);
  });

  function transportFixture() {
    const child = Object.assign(fakeChild(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
    });
    child.stderr.end();
    return { child, transport: new ZCodeStdioTransport(child as never) };
  }

  it.each([0, 400])("Review1 I1 部分成员ESRCH后旧M延迟%s不得作用于复用PID", async (delay) => {
    const child = fakeChild();
    alivePids = new Set([4242, 5000, 5001]);
    powershellResult += powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    const snapshot = await captureProcessTreeSnapshotAsync(child);
    child.exitCode = 0;
    alivePids.delete(4242);
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 2000,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1);
    targetedDelayMs = delay;
    await vi.advanceTimersByTimeAsync(1249);
    expect(queryEvents.at(-1)?.pids).toEqual(expect.arrayContaining([5000, 5001]));
    await vi.advanceTimersByTimeAsync(249);
    alivePids.delete(5000);
    await vi.advanceTimersByTimeAsync(401);
    alivePids.add(5000);
    powershellResult = powershellIdentityAt(5000, 1, Date.now()) + powershellIdentity(5001, 1);
    const effectBeforeForce = taskkillEffect.length;
    await vi.advanceTimersByTimeAsync(1350);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([5001]);
    expect(taskkillEffect.slice(effectBeforeForce)).toEqual([5001]);
    expect(alivePids).toEqual(new Set([5000]));
  });

  it("Review1 I1 force后旧report不能把已ESRCH成员重新计入remaining", async () => {
    const child = fakeChild();
    alivePids = new Set([4242, 5000, 5001]);
    powershellResult += powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    const snapshot = await captureProcessTreeSnapshotAsync(child);
    child.exitCode = 0;
    alivePids.delete(4242);
    taskkillEnabled = false;
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 2000,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1499);
    alivePids.delete(5000);
    await vi.advanceTimersByTimeAsync(401);
    alivePids.add(5000);
    powershellResult = powershellIdentityAt(5000, 1, Date.now()) + powershellIdentity(5001, 1);
    await vi.advanceTimersByTimeAsync(1350);
    await expect(result).resolves.toEqual({ remainingPids: [5001] });
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([5001]);
    expect(alivePids).toEqual(new Set([5000, 5001]));
  });

  it("Review1 I1 连续OS探测中后一次ESRCH也必须持久撤销旧M", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const start = Date.now();
    alivePids = new Set([5000, 5001]);
    powershellResult = powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    const originalProbe = vi.mocked(process.kill).getMockImplementation()!;
    let childProbes = 0;
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      if (pid === 5000 && Date.now() >= start + 1500 && ++childProbes === 2) {
        powershellResult = powershellIdentityAt(5000, 1, Date.now()) + powershellIdentity(5001, 1);
        throw Object.assign(new Error("old child exited before PID reuse"), { code: "ESRCH" });
      }
      return originalProbe(pid, signal);
    });
    const result = terminateProcessTreeAndWait(child, {
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000, 5001],
        identities: [5000, 5001].map((pid) => ({
          pid,
          parentPid: 4242,
          startTime: "windows-utc-100ns:17848908000000000",
        })),
      },
      forceAfterMs: 2000,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3250);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([5001]);
    expect(alivePids).toEqual(new Set([5000]));
  });

  it("Review1 I2 同tick dispose与disposeAndWait共用首次发现及清理链", async () => {
    const { transport } = transportFixture();
    alivePids = new Set([4242, 5000, 5001]);
    powershellResult += powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    powershellDelayMs = 100;
    taskkillEnabled = false;
    transport.dispose();
    const waiting = transport.disposeAndWait();
    const checked = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    const firstDiscoveryCount = queryEvents.filter(({ pids }) => pids.length === 0).length;
    const firstPeak = peakQueries;
    await vi.advanceTimersByTimeAsync(3249);
    expect(await checked).toBeInstanceOf(Error);
    expect(String(await checked)).toContain("remaining pid=4242,5000,5001");
    expect(firstDiscoveryCount).toBe(1);
    expect(firstPeak).toBe(1);
    expect(queryEvents.filter(({ pids }) => pids.length === 0)).toHaveLength(1);
    expect(peakQueries).toBe(1);
  });

  it("Review1 I2 同owner定向准入在await后排他且逻辑截止不释放物理占用", async () => {
    const owner = fakeChild();
    const start = Date.now();
    const identities = [
      { pid: 4242, parentPid: 1, startTime: "windows-utc-100ns:17848908000000000" },
    ];
    targetedDelayMs = 100;
    const first = verifyWindowsProcessIdentitiesAsync(identities, start + 40, owner, {});
    const second = verifyWindowsProcessIdentitiesAsync(identities, start + 80, owner, {});
    await vi.advanceTimersByTimeAsync(40);
    expect((await first).unknownIdentities).toEqual(identities);
    expect(queryEvents).toHaveLength(1);
    expect(peakQueries).toBe(1);
    await vi.advanceTimersByTimeAsync(40);
    expect((await second).unknownIdentities).toEqual(identities);
    expect(hasWindowsProcessQueryInFlight(owner)).toBe(true);
    expect(activeQueries).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(hasWindowsProcessQueryInFlight(owner)).toBe(false);
    expect(queryEvents).toHaveLength(1);
  });

  it("Review1 I2 共享全表先结束不能覆盖同owner旧定向占用", async () => {
    const owner = fakeChild();
    const start = Date.now();
    const identities = [
      { pid: 4242, parentPid: 1, startTime: "windows-utc-100ns:17848908000000000" },
    ];
    targetedDelayMs = 100;
    const targeted = verifyWindowsProcessIdentitiesAsync(identities, start + 40, owner, {});
    await vi.advanceTimersByTimeAsync(1);
    powershellDelayMs = 20;
    const unrelated = readWindowsProcessListAsync({ windowsCleanupDeadlineAtMs: start + 80 }, {});
    await vi.advanceTimersByTimeAsync(1);
    const competing = readWindowsProcessListAsync(
      { windowsCleanupDeadlineAtMs: start + 80 },
      owner,
    );
    await vi.advanceTimersByTimeAsync(20);
    await unrelated;
    expect(hasWindowsProcessQueryInFlight(owner)).toBe(true);
    await vi.advanceTimersByTimeAsync(58);
    expect((await targeted).unknownIdentities).toEqual(identities);
    await expect(competing).resolves.toEqual([]);
    expect(hasWindowsProcessQueryInFlight(owner)).toBe(true);
    expect(queryEvents).toHaveLength(2);
    expect(taskkillCommands()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(hasWindowsProcessQueryInFlight(owner)).toBe(false);
  });

  it("W14 真实Transport最终retry复用K且root仍活不重复EOF", async () => {
    const { child, transport } = transportFixture();
    alivePids = new Set([4242, 5000, 5001]);
    powershellResult += powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    powershellDelayMs = 50;
    taskkillEnabled = false;
    const first = transport.disposeAndWait();
    const firstCheck = expect(first).rejects.toThrow("remaining pid=4242,5000,5001");
    await vi.advanceTimersByTimeAsync(3250);
    await firstCheck;
    expect(child.exitCode).toBeNull();
    taskkillEnabled = true;
    const second = transport.disposeAndWait();
    const secondCheck = expect(second).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1250);
    await secondCheck;
    expect(queryEvents.filter(({ pids }) => pids.length === 0)).toHaveLength(1);
    expect(queryEvents.filter(({ pids }) => pids.length > 0).at(-1)?.timeout).toBe(500);
    expect(alivePids.size).toBe(0);
  });

  it.each([3300, 4501])("W13/W14 跨attempt物理查询至%s隔离旧M与deadline", async (endAt) => {
    const start = Date.now();
    const { transport } = transportFixture();
    alivePids = new Set([4242, 5000, 5001]);
    powershellResult += powershellIdentity(5000, 4242) + powershellIdentity(5001, 5000);
    powershellDelayMs = 50;
    targetedDelayMs = endAt - 1850;
    taskkillEnabled = false;
    const first = transport.disposeAndWait();
    const firstCheck = expect(first).rejects.toThrow("cleanup incomplete");
    await vi.advanceTimersByTimeAsync(3250);
    await firstCheck;
    const commandCount = taskkillCommands().length;
    powershellResult = powershellResult.replace(
      powershellIdentity(5000, 4242),
      powershellIdentityAt(5000, 4242, Date.now()),
    );
    targetedDelayMs = 0;
    taskkillEnabled = true;
    const second = transport.disposeAndWait();
    const secondCheck =
      endAt === 3300
        ? expect(second).resolves.toBeUndefined()
        : expect(second).rejects.toThrow("remaining pid=4242,5000,5001");
    await vi.advanceTimersByTimeAsync(49);
    expect(queryEvents.filter(({ pids }) => pids.length > 0)).toHaveLength(1);
    expect(taskkillCommands()).toHaveLength(commandCount);
    await vi.advanceTimersByTimeAsync(1201);
    await secondCheck;
    const finalCount = taskkillCommands().length;
    await vi.advanceTimersByTimeAsync(10);
    expect(peakQueries).toBe(1);
    expect(taskkillCommands()).toHaveLength(finalCount);
    expect(queryEvents.filter(({ pids }) => pids.length === 0)).toHaveLength(1);
    if (endAt === 3300) {
      expect(queryEvents.at(-1)).toMatchObject({ started: start + 3300, timeout: 475 });
      expect(
        taskkillCommands()
          .slice(commandCount)
          .map(({ pid }) => pid),
      ).toEqual([4242, 5001]);
      expect(alivePids).toEqual(new Set([5000]));
    } else expect(queryEvents.filter(({ pids }) => pids.length > 0)).toHaveLength(1);
  });

  it.each(["4242 OR 1=1", -1, 0, 1.5, NaN, Infinity, 4294967296])(
    "W13 非法PID %s在CIM及runner边界拒绝",
    async (pid) => {
      const identity = { pid: pid as number, parentPid: 1, startTime: "windows-utc-100ns:1" };
      expect(await filterCurrentProcessIdentitiesAsync([identity], {})).toEqual([]);
      expect(filterCurrentProcessIdentities([identity], {})).toEqual([]);
      const result = await defaultWindowsTaskkillRunner({
        pid: pid as number,
        force: true,
        timeoutMs: 100,
      });
      expect(result.error).toBeDefined();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it("W13 已匹配首批不被第二批超时/未发第三批抹掉", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const identities = Array.from({ length: 129 }, (_, index) => ({
      pid: 5000 + index,
      parentPid: 4242,
      startTime: "windows-utc-100ns:17848908000000000",
    }));
    alivePids = new Set(identities.map(({ pid }) => pid));
    powershellResult = identities.map(({ pid }) => powershellIdentity(pid, 4242)).join("");
    const original = execFileMock.getMockImplementation()!;
    let targetedCount = 0;
    execFileMock.mockImplementation((command, args, options, callback) => {
      if (command === "powershell.exe" && args.join(" ").includes("ProcessId =")) {
        targetedCount += 1;
        if (targetedCount === 2) targetedDelayMs = 600;
      }
      return original(command, args, options, callback);
    });
    const result = terminateProcessTreeAndWait(child, {
      snapshot: { rootPid: 4242, identities, descendantPids: identities.map(({ pid }) => pid) },
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({
      remainingPids: identities.slice(64).map(({ pid }) => pid),
    });
    expect(taskkillCommands().map(({ pid }) => pid)).toEqual(
      identities.slice(0, 64).map(({ pid }) => pid),
    );
    expect(queryEvents.map(({ pids }) => pids.length)).toEqual([64, 64]);
    expect(peakQueries).toBe(1);
  });

  it("W13 单项坏行/重复仅该项unknown，完整成功空响应证明gone", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const identities = [5000, 5001, 5002, 5003].map((pid) => ({
      pid,
      parentPid: 4242,
      startTime: "windows-utc-100ns:17848908000000000",
    }));
    alivePids = new Set([5000, 5001, 5002, 5003]);
    targetedPowerShellResult =
      powershellIdentity(5000, 1) +
      "5001 1 malformed\n" +
      powershellIdentity(5002, 1) +
      powershellIdentity(5002, 1);
    const result = terminateProcessTreeAndWait(child, {
      snapshot: { rootPid: 4242, identities, descendantPids: [5000, 5001, 5002, 5003] },
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [5001, 5002] });
    expect(taskkillEffect).toEqual([5000]);
    expect(alivePids).toContain(5003);
  });

  it.each([0, 1, 100])("W14 R=%s固定截止且不以750为准入门槛", async (remaining) => {
    const child = fakeChild();
    child.exitCode = 0;
    alivePids = new Set([5000]);
    powershellResult = powershellIdentity(5000, 4242);
    const identities = [
      { pid: 5000, parentPid: 4242, startTime: "windows-utc-100ns:17848908000000000" },
    ];
    targetedDelayMs = 10;
    const start = Date.now();
    let settled = false;
    const result = terminateProcessTreeAndWait(child, {
      snapshot: { rootPid: 4242, identities, descendantPids: [5000] },
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
      windowsCleanupDeadlineAtMs: start + remaining,
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(remaining);
    expect(settled).toBe(true);
    await expect(result).resolves.toEqual({ remainingPids: remaining === 100 ? [] : [5000] });
    if (remaining === 100) {
      expect(queryEvents).toMatchObject([{ started: start, timeout: 33, pids: [5000] }]);
      expect(execFileMock.mock.calls.find(([command]) => command === "taskkill")?.[2].timeout).toBe(
        57,
      );
    } else {
      expect(queryEvents).toEqual([]);
      expect(taskkillCommands()).toEqual([]);
    }
    const count = execFileMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(execFileMock).toHaveBeenCalledTimes(count);
  });

  it("W14 无显式D的公开入口把首次发现计入F+L+G", async () => {
    const child = fakeChild();
    powershellDelayMs = 60;
    targetedDelayMs = 1000;
    taskkillEnabled = false;
    let settled = false;
    const result = terminateProcessTreeAndWait(child, {
      forceAfterMs: 100,
      windowsTaskkillTimeoutMs: 100,
      waitAfterForceMs: 30,
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(229);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(result).resolves.toEqual({ remainingPids: [4242] });
    expect(queryEvents[0]?.timeout).toBe(230);
    const count = execFileMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(execFileMock).toHaveBeenCalledTimes(count);
  });

  it("W14 waiter提前settle后旧查询不启动下一批或新timer", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const identities = Array.from({ length: 65 }, (_, index) => ({
      pid: 5000 + index,
      parentPid: 4242,
      startTime: "windows-utc-100ns:17848908000000000",
    }));
    alivePids = new Set(identities.map(({ pid }) => pid));
    powershellResult = identities.map(({ pid }) => powershellIdentity(pid, 4242)).join("");
    targetedDelayMs = 100;
    const result = terminateProcessTreeAndWait(child, {
      snapshot: { rootPid: 4242, identities, descendantPids: identities.map(({ pid }) => pid) },
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1);
    alivePids.clear();
    await vi.advanceTimersByTimeAsync(24);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    await vi.advanceTimersByTimeAsync(200);
    expect(queryEvents).toHaveLength(1);
    expect(taskkillCommands()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("W12 任意kill对象不能启用CIM失败root例外", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    powershellError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const result = terminateProcessTreeAndWait(child, {
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [{ pid: 4242, parentPid: 1, startTime: "windows-utc-100ns:17848908000000000" }],
      },
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [4242] });
    expect(taskkillCommands()).toEqual([]);
  });

  it("W14 真实Transport全部unavailable重试只观察750ms且不重复全表", async () => {
    const { transport } = transportFixture();
    powershellError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const first = transport.disposeAndWait();
    const checked = expect(first).rejects.toThrow("cleanup incomplete");
    await vi.advanceTimersByTimeAsync(3250);
    await checked;
    let settled = false;
    const second = transport.disposeAndWait().catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(749);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await second).toBeInstanceOf(Error);
    expect(queryEvents).toHaveLength(1);
    expect(taskkillEffect).toEqual([]);
  });

  it("W17 POSIX既有PGID与reparent、SIGTERM/SIGKILL语义保持", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const child = fakeChild();
    child.exitCode = 0;
    alivePids = new Set([5000, 5001]);
    const rows =
      "5000 1 4242 Tue Nov 17 12:00:00 2026 node child\n5001 1 4242 Tue Nov 17 12:00:00 2026 node grandchild\n";
    spawnSyncMock.mockImplementation((command, args) => {
      if (command !== "ps" || !args.includes("pid=,ppid=,pgid=,lstart=,command="))
        throw new Error("未知POSIX命令");
      return { status: 0, stdout: rows };
    });
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      if (Number(pid) === -4242 && signal === "SIGKILL") alivePids.clear();
      if (Number(pid) < 0 || alivePids.has(Number(pid))) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const result = terminateProcessTreeAndWait(child, {
      ownedProcessGroupId: 4242,
      forceAfterMs: 100,
      waitAfterForceMs: 30,
    });
    await vi.advanceTimersByTimeAsync(130);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(process.kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(process.kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("W06 可信exit时间优先于滞后的ChildProcess状态", async () => {
    powershellResult =
      powershellIdentityAt(4242, 1, 1100) +
      powershellIdentityAt(5000, 4242, 1000) +
      powershellIdentityAt(5001, 4242, 1100);
    const snapshot = await captureProcessTreeSnapshotAsync(fakeChild(), {
      ownedProcessStartedAtMs: 1000,
      ownedProcessExitedAtMs: 1100,
    });
    expect(snapshot?.identities.map(({ pid }) => pid)).toEqual([5000]);
  });

  it("W12/W15 验证后force前原root退出不得向复用root发信号", async () => {
    const child = fakeChild();
    powershellResult += powershellIdentity(5000, 4242);
    alivePids = new Set([4242, 5000]);
    const snapshot = await captureProcessTreeSnapshotAsync(child);
    const result = terminateProcessTreeAndWait(child, {
      snapshot,
      forceAfterMs: 1000,
      windowsTaskkillTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(250);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    powershellResult = powershellIdentityAt(4242, 1, Date.now()) + powershellIdentity(5000, 1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ remainingPids: [] });
    expect(
      taskkillCommands()
        .filter(({ force }) => force)
        .map(({ pid }) => pid),
    ).toEqual([5000]);
    expect(alivePids).toEqual(new Set([4242]));
  });

  it("W04 matched后OS探测EPERM仍记录unresolved", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    powershellResult = powershellIdentity(5000, 4242);
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const warning = vi.fn();
    const result = terminateProcessTreeAndWait(child, {
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          { pid: 5000, parentPid: 4242, startTime: "windows-utc-100ns:17848908000000000" },
        ],
      },
      forceAfterMs: 0,
      windowsTaskkillTimeoutMs: 1000,
      log: { warn: warning },
    });
    await vi.advanceTimersByTimeAsync(1250);
    await expect(result).resolves.toEqual({ remainingPids: [5000] });
    expect(
      warning.mock.calls.some(([, message]) => String(message).includes("unresolved=5000")),
    ).toBe(true);
  });

  it("CIM 硬不可用时缓存 capability 并跳过后续身份查询", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellError = Object.assign(new Error("powershell unavailable"), { code: "ENOENT" });

    await expect(captureProcessTreeSnapshotAsync(child)).resolves.toBeUndefined();
    const queryCount = execFileMock.mock.calls.filter(
      ([command]) => command === "powershell.exe",
    ).length;

    await expect(
      filterCurrentProcessIdentitiesAsync(
        [{ parentPid: 1, pid: 4242, startTime: "windows-utc-100ns:17848908000000000" }],
        {},
      ),
    ).resolves.toEqual([]);
    expect(
      execFileMock.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toHaveLength(queryCount);
  });
});
