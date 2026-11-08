import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { utilityProcess as electronUtilityProcess } from "electron";
import { createCronSchedulerSupervisor } from "../src/main/desktopCronScheduler.js";

// docs/desktop/host-idle-resources-1.1-spec.md §4：scheduler 只在有调度工作时运行。

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock("../src/main/desktopRuntimeEnv.js", () => ({
  buildHostProcessEnv: vi.fn(() => ({})),
  schedulerModulePath: "/tmp/zcode-scheduler.js",
}));

class MockSchedulerProcess extends EventEmitter {
  pid: number | undefined = 12345;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

const forkedChildren: MockSchedulerProcess[] = [];

function mockForks() {
  vi.mocked(electronUtilityProcess.fork).mockImplementation(() => {
    const child = new MockSchedulerProcess();
    // scheduler 收到 scheduler-dispose 后释放认领并退出。
    child.postMessage.mockImplementation((message: { type: string }) => {
      if (message.type === "scheduler-dispose") queueMicrotask(() => child.emit("exit", 0));
    });
    forkedChildren.push(child);
    return child as never;
  });
}

function createSupervisor() {
  mockForks();
  return createCronSchedulerSupervisor({
    hostProcessLocalEnv: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveDispatchHost: () => null,
  });
}

function forkEnv(index: number): Record<string, string> {
  const call = vi.mocked(electronUtilityProcess.fork).mock.calls[index];
  if (!call) throw new Error(`fork #${index} was not called`);
  return (call[2] as { env: Record<string, string> }).env;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  forkedChildren.length = 0;
  vi.mocked(electronUtilityProcess.fork).mockReset();
});

describe("cron scheduler supervisor", () => {
  it("CRON01: 无调度工作时报告空闲，Main 让 scheduler 优雅退出", async () => {
    const supervisor = createSupervisor();
    supervisor.start();
    expect(forkedChildren).toHaveLength(1);
    expect(forkEnv(0).ZCODE_SCHEDULER_WAKE_SEQ).toBe("0");
    forkedChildren[0]!.emit("message", { type: "scheduler-idle", wakeSeq: 0 });
    expect(forkedChildren[0]!.postMessage).toHaveBeenCalledWith({ type: "scheduler-dispose" });
    await flush();
    await supervisor.dispose();
  });

  it("CRON02: 退出后新建/启用自动化的唤醒重新拉起，初始序号为最新唤醒", async () => {
    const supervisor = createSupervisor();
    supervisor.start();
    forkedChildren[0]!.emit("message", { type: "scheduler-idle", wakeSeq: 0 });
    await flush();
    supervisor.wake("automation-1");
    expect(forkedChildren).toHaveLength(2);
    expect(forkEnv(1).ZCODE_SCHEDULER_WAKE_SEQ).toBe("1");
    await supervisor.dispose();
  });

  it("CRON03: 空闲报告早于最新唤醒时不退出，唤醒带序号转发", async () => {
    const supervisor = createSupervisor();
    supervisor.start();
    supervisor.wake("automation-1");
    expect(forkedChildren[0]!.postMessage).toHaveBeenCalledWith({
      type: "scheduler-wake",
      automationId: "automation-1",
      wakeSeq: 1,
    });
    // scheduler 在收到序号 1 之前完成的查询：可能没看到新提交的自动化，不能据此退出。
    forkedChildren[0]!.emit("message", { type: "scheduler-idle", wakeSeq: 0 });
    expect(forkedChildren[0]!.postMessage).not.toHaveBeenCalledWith({ type: "scheduler-dispose" });
    forkedChildren[0]!.emit("message", { type: "scheduler-idle", wakeSeq: 1 });
    expect(forkedChildren[0]!.postMessage).toHaveBeenCalledWith({ type: "scheduler-dispose" });
    await flush();
    await supervisor.dispose();
  });

  it("CRON04: 空闲退出过程中收到唤醒，退出完成后重新拉起", async () => {
    vi.mocked(electronUtilityProcess.fork).mockReset();
    const supervisor = createSupervisor();
    supervisor.start();
    const first = forkedChildren[0]!;
    // 让退出停在半途：dispose 后暂不 exit。
    first.postMessage.mockImplementation(() => undefined);
    first.emit("message", { type: "scheduler-idle", wakeSeq: 0 });
    supervisor.wake("automation-2");
    expect(forkedChildren).toHaveLength(1);
    first.emit("exit", 0);
    await flush();
    expect(forkedChildren).toHaveLength(2);
    expect(forkEnv(1).ZCODE_SCHEDULER_WAKE_SEQ).toBe("1");
    await supervisor.dispose();
  });

  it("应用退出后不再拉起", async () => {
    const supervisor = createSupervisor();
    supervisor.start();
    const disposing = supervisor.dispose();
    await disposing;
    supervisor.wake("automation-3");
    expect(forkedChildren).toHaveLength(1);
  });
});
