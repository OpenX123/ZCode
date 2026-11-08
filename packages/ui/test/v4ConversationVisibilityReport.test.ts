// docs/desktop/engine-performance-1.1-spec.md「会话可见性上报」VR01–VR03（P3 Renderer）。
// 可见性上报器是每个工作区连接（workspaceConnectionRegistry 条目）的可见集合唯一所有者：
// 合并同工作区多个 pane、同一提交周期只报一次、串行且后到覆盖、不拉起 CLI、runtime 换代后重报。
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ZCodeAgentRuntimeLifecycleEvent } from "@zcode/services";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "@/v4/workspaceConnectionRegistry.js";

let workspaceSerial = 0;
function nextWorkspace(): string {
  workspaceSerial += 1;
  return `/visibility-${workspaceSerial}`;
}

function mockAgentService() {
  const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const restarts = new Emitter<{ workspaceKey: string }>();
  const report = vi.fn(
    async (_params: { workspacePath: string; visibleSessionIds: string[] }) => {},
  );
  const service = {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId: "test-connection",
      clientMode: "desktop-continuous" as const,
      deliveryProfile: "continuous" as const,
      serverTime: 1,
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none" as const,
      },
      auth: {},
    })),
    initializeConversationV4: vi.fn(async () => {}),
    queryConversationCommandsV4: vi.fn(async () => ({ results: [] })),
    onDynamicConversationFrame: vi.fn(() => () => ({ dispose: () => {} })),
    onAgentRuntimeRestarted: restarts.event,
    onAgentRuntimeLifecycle: lifecycle.event,
    reportConversationVisibilityV4: report,
  } as unknown as WorkspaceConnectionAgentService;
  return { service, report, lifecycle, restarts };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function reported(report: ReturnType<typeof mockAgentService>["report"]): string[][] {
  return report.mock.calls.map(([params]) => params.visibleSessionIds);
}

function lifecycleEvent(workspacePath: string, state: "available" | "unavailable") {
  return {
    workspacePath,
    workspaceKey: workspacePath,
    runtimeIdentity: { generation: 2, identity: `${workspacePath}:2:1`, processId: 1 },
    state,
  } as ZCodeAgentRuntimeLifecycleEvent;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("工作区连接的会话可见性上报", () => {
  it("VR01：同工作区多个 pane 合并为一次上报，集合未变不重报，隐藏后整体替换", async () => {
    const { service, report } = mockAgentService();
    const workspacePath = nextWorkspace();
    const first = acquireWorkspaceConnection({ workspacePath }, service);
    const second = acquireWorkspaceConnection({ workspacePath }, service);

    first.setPaneVisibleSession("pane-a", "session-2");
    second.setPaneVisibleSession("pane-b", "session-1");
    second.setPaneVisibleSession("pane-c", null);
    await flush();
    expect(reported(report)).toEqual([["session-1", "session-2"]]);
    expect(report.mock.calls[0]![0]).toMatchObject({ workspacePath });
    expect(report.mock.calls[0]![0]).not.toHaveProperty("connectionId");

    first.setPaneVisibleSession("pane-a", "session-2");
    await flush();
    expect(report).toHaveBeenCalledTimes(1);

    second.setPaneVisibleSession("pane-b", null);
    await flush();
    expect(reported(report)).toEqual([["session-1", "session-2"], ["session-2"]]);
    first.release();
    second.release();
  });

  it("VR01：在途期间的变化在返回后以最新集合补发，保证后到覆盖先到", async () => {
    const { service, report } = mockAgentService();
    let finishFirst!: () => void;
    report.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const lease = acquireWorkspaceConnection({ workspacePath: nextWorkspace() }, service);
    lease.setPaneVisibleSession("pane-a", "session-1");
    await flush();
    lease.setPaneVisibleSession("pane-a", "session-2");
    await flush();
    lease.setPaneVisibleSession("pane-b", "session-3");
    await flush();
    expect(reported(report)).toEqual([["session-1"]]);

    finishFirst();
    await flush();
    expect(reported(report)).toEqual([["session-1"], ["session-2", "session-3"]]);
    lease.release();
  });

  it("VR01：从未有可见会话时不上报", async () => {
    const { service, report } = mockAgentService();
    const lease = acquireWorkspaceConnection({ workspacePath: nextWorkspace() }, service);
    lease.setPaneVisibleSession("pane-a", null);
    await flush();
    expect(report).not.toHaveBeenCalled();
    lease.release();
  });

  it("VR02：窗口隐藏时上报空集合，回到前台按当前布局重报", async () => {
    const listeners = new Set<() => void>();
    const fakeDocument = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    (globalThis as { document?: unknown }).document = fakeDocument;
    const { service, report } = mockAgentService();
    const lease = acquireWorkspaceConnection({ workspacePath: nextWorkspace() }, service);
    lease.setPaneVisibleSession("pane-a", "session-1");
    await flush();

    fakeDocument.visibilityState = "hidden";
    for (const listener of listeners) listener();
    await flush();
    fakeDocument.visibilityState = "visible";
    for (const listener of listeners) listener();
    await flush();
    expect(reported(report)).toEqual([["session-1"], [], ["session-1"]]);
    lease.release();
  });

  it("VR03：CLI 不在时上报失败只记一次、不重试；runtime available 或 proxy 换代后按当前集合重报", async () => {
    vi.useFakeTimers();
    try {
      const { service, report, lifecycle } = mockAgentService();
      report.mockRejectedValueOnce(new Error("runtime unavailable"));
      const workspacePath = nextWorkspace();
      const lease = acquireWorkspaceConnection({ workspacePath }, service);
      lease.setPaneVisibleSession("pane-a", "session-1");
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(report).toHaveBeenCalledTimes(1);

      lifecycle.fire(lifecycleEvent(workspacePath, "available"));
      await flush();
      expect(reported(report)).toEqual([["session-1"], ["session-1"]]);

      // 另一个工作区的 runtime 事件不触发本连接重报。
      lifecycle.fire(lifecycleEvent(nextWorkspace(), "available"));
      await flush();
      expect(report).toHaveBeenCalledTimes(2);
      lease.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
