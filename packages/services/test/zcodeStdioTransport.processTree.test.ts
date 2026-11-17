import { spawn } from "node:child_process";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    execFile: vi.fn(actual.execFile),
  };
});

const { terminateProcessTreeAndWaitMock } = vi.hoisted(() => ({
  terminateProcessTreeAndWaitMock: vi.fn(async () => ({ remainingPids: [] as number[] })),
}));

vi.mock("#src/process/processTreeTerminator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/process/processTreeTerminator.js")>()),
  captureProcessTreeSnapshotAsync: vi.fn(async (child: { pid?: number }) => ({
    rootPid: child.pid!,
    descendantPids: [],
    identities: [],
  })),
  captureExitedRootDescendantsSnapshotAsync: vi.fn(async () => undefined),
  captureProcessGroupSnapshot: vi.fn(() => undefined),
  terminateProcessTreeAndWait: terminateProcessTreeAndWaitMock,
}));

import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";
import { captureExitedRootDescendantsSnapshotAsync } from "#src/process/processTreeTerminator.js";
import * as processTreeTerminator from "#src/process/processTreeTerminator.js";

const activeChildren = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  terminateProcessTreeAndWaitMock.mockReset();
  terminateProcessTreeAndWaitMock.mockResolvedValue({ remainingPids: [] });
  vi.restoreAllMocks();
  await Promise.all(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  activeChildren.clear();
});

describe("ZCodeStdioTransport POSIX retry 全mock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("ZCODE_E2E_COVERAGE", "0");
    const unexpectedOsCall = () => {
      throw new Error("POSIX retry 回归禁止真实 OS 调用");
    };
    vi.spyOn(childProcess, "spawn").mockImplementation(unexpectedOsCall);
    vi.spyOn(childProcess, "spawnSync").mockImplementation(unexpectedOsCall);
    vi.spyOn(childProcess, "execFile").mockImplementation(unexpectedOsCall);
    vi.spyOn(process, "kill").mockImplementation(unexpectedOsCall);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "POSIX 首轮残留后恢复 EOF 自然退出窗口，首轮有快照=%s",
    async (hasInitialSnapshot) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        exitCode: null as number | null,
        signalCode: null,
        killed: false,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      child.stderr.destroy();
      const snapshot = { rootPid: 4242, descendantPids: [5000], identities: [] };
      const capture = vi.spyOn(processTreeTerminator, "captureProcessTreeSnapshotAsync");
      capture.mockClear();
      capture.mockResolvedValueOnce(hasInitialSnapshot ? snapshot : undefined);
      capture.mockResolvedValue(snapshot);
      const exitedCapture = vi.mocked(captureExitedRootDescendantsSnapshotAsync);
      exitedCapture.mockClear();
      const eof = vi.spyOn(child.stdin, "end");
      const terminationEvents: { at: number; exited: boolean }[] = [];
      terminateProcessTreeAndWaitMock.mockReset();
      terminateProcessTreeAndWaitMock.mockImplementation(async () => {
        terminationEvents.push({ at: Date.now(), exited: child.exitCode !== null });
        return { remainingPids: child.exitCode === null ? [4242] : [] };
      });
      const transport = new ZCodeStdioTransport(child as never);

      const first = expect(transport.disposeAndWait()).rejects.toThrow("remaining pid=4242");
      await vi.advanceTimersByTimeAsync(1799);
      expect(terminationEvents).toEqual([]);
      expect(eof).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(terminationEvents).toEqual([{ at: 1800, exited: false }]);

      // 首轮失败后原 child 仍活，POSIX retry 必须重新给 EOF 收尾机会；
      // 首轮 undefined 不能冻结发现，已有非空快照则仍按原语义复用。
      const second = transport.disposeAndWait().then(
        () => undefined,
        (error: unknown) => error,
      );
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 500);
      await vi.advanceTimersByTimeAsync(499);
      expect(capture).toHaveBeenCalledTimes(hasInitialSnapshot ? 1 : 2);
      expect(terminationEvents).toHaveLength(1);
      // 同一 stdin 首轮已 end，retry 的 EOF 请求按既有 writable 门禁幂等；等待仍必须保留。
      expect(eof).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(await second).toBeUndefined();
      expect(terminationEvents).toEqual([
        { at: 1800, exited: false },
        { at: 2300, exited: true },
      ]);
      expect(capture).toHaveBeenCalledTimes(hasInitialSnapshot ? 1 : 2);
      expect(exitedCapture).toHaveBeenCalledTimes(hasInitialSnapshot ? 0 : 1);
      expect(terminateProcessTreeAndWaitMock).toHaveBeenLastCalledWith(
        child,
        expect.objectContaining({ snapshot }),
      );
    },
  );
});

describe("ZCodeStdioTransport process tree result", () => {
  it("等待器确认 OS 进程树已退出时不被滞后的 ChildProcess 状态改判为残留", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    const startedAt = performance.now();

    // Bug 回归：Windows taskkill 已完成且 waiter 根据 OS 存活事实返回成功时，
    // Node 的 exit 事件仍可能晚一轮投递，child.exitCode 此刻合法地保持 null。
    await expect(transport.disposeAndWait()).resolves.toBeUndefined();
    // stderr drain 只能使用 250ms，不能重新借到整个 Windows 进程树窗口。
    expect(performance.now() - startedAt).toBeLessThan(3_500);
    expect(terminateProcessTreeAndWaitMock).toHaveBeenCalledOnce();
    expect(terminateProcessTreeAndWaitMock).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ windowsCleanupDeadlineAtMs: 13_250 }),
    );
    expect(child.exitCode).toBeNull();
  });
});
