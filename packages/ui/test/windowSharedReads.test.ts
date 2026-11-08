// @vitest-environment jsdom
// docs/desktop/engine-performance-1.1-spec.md「窗口级只读数据共享」WR01–WR04（P5）。
// 现场：窗口打开时每个 SessionPane（含隐藏 Tab）各读一次 getBotStates / getView / getConnectionProfiles，
// 且每次变化事件各实例各自重读。这里在同一服务实例上挂多个实例，按调用次数断言共享读取。
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { ExternalEngineConnectionsView } from "@zcode/shared/external-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBotGroupTask } from "@/hooks/useBotGroupTask.js";
import { useEngineConnectionProfiles } from "@/hooks/external-engine/useEngineConnectionProfiles.js";
import type { ExternalEngineServiceHandle } from "@/hooks/external-engine/useExternalEngineService.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";

const servicesRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => servicesRef.current }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

afterEach(() => {
  cleanup();
});

function view(revision: number): ModelSelectionView {
  return {
    revision,
    providers: [{ providerId: "p", config: {}, models: [{ modelId: "m", config: {} }] }],
  } as unknown as ModelSelectionView;
}

function modelSelectionService() {
  const emitter = new Emitter<ModelSelectionView>();
  let revision = 1;
  const getView = vi.fn(async (input?: unknown) => ({
    ...view(revision),
    ...(input ? { effectiveSelection: (input as { selection: unknown }).selection } : {}),
  }));
  const service = { getView, onDidChange: emitter.event } as unknown as IModelSelectionService;
  return {
    service,
    getView,
    fire(next: number) {
      revision = next;
      emitter.fire(view(next));
    },
  };
}

const selection = { providerId: "p", modelId: "m" };

function useSessionPaneModelReads(service: IModelSelectionService) {
  // 与一个 SessionPane 同构：草稿就绪门禁（无输入）+ Composer 模型选择（带 selection）。
  const gate = useDraftModelReadinessGate({
    workspacePath: "/workspace",
    sessionId: null,
    modelSelectionService: service,
  });
  const read = useModelSelectionServiceView(service, true, "remote-waiting", { selection });
  return { gate, read };
}

describe("Model Selection 共享读取", () => {
  it("WR01/WR02：多个面板同键只读一次；变化事件后每个键只重读一次，无输入键直接用事件负载", async () => {
    const { service, getView, fire } = modelSelectionService();
    const panes = renderHook(() => [
      useSessionPaneModelReads(service),
      useSessionPaneModelReads(service),
      useSessionPaneModelReads(service),
    ]);
    await waitFor(() =>
      expect(panes.result.current.every((pane) => pane.read.state.status === "ready")).toBe(true),
    );
    // 修复前：3 个门禁 + 3 个 selection 读取 = 6 次。
    expect(getView).toHaveBeenCalledTimes(2);

    // 后挂载的面板复用缓存，不再读取。
    const late = renderHook(() => useSessionPaneModelReads(service));
    await waitFor(() => expect(late.result.current.read.state.status).toBe("ready"));
    expect(getView).toHaveBeenCalledTimes(2);

    act(() => fire(2));
    await waitFor(() =>
      expect(
        panes.result.current.every(
          (pane) => pane.read.state.status === "ready" && pane.read.state.view.revision === 2,
        ),
      ).toBe(true),
    );
    // 修复前：4 个 selection 实例各重读一次。现在只有 selection 键重读一次。
    expect(getView).toHaveBeenCalledTimes(3);
    expect(getView).toHaveBeenLastCalledWith({ selection });
    late.unmount();
    panes.unmount();
  });

  it("WR03/WR04：全部卸载后重新读取；不同服务实例互不复用；reload 总是新请求", async () => {
    const first = modelSelectionService();
    const second = modelSelectionService();
    const mounted = renderHook(() => useModelSelectionServiceView(first.service));
    await waitFor(() => expect(mounted.result.current.state.status).toBe("ready"));
    mounted.unmount();

    const again = renderHook(() => useModelSelectionServiceView(first.service));
    await waitFor(() => expect(again.result.current.state.status).toBe("ready"));
    expect(first.getView).toHaveBeenCalledTimes(2);

    const other = renderHook(() => useModelSelectionServiceView(second.service));
    await waitFor(() => expect(other.result.current.state.status).toBe("ready"));
    expect(second.getView).toHaveBeenCalledTimes(1);
    expect(first.getView).toHaveBeenCalledTimes(2);

    act(() => again.result.current.reload());
    await waitFor(() => expect(first.getView).toHaveBeenCalledTimes(3));
    await expect(again.result.current.refresh()).resolves.toMatchObject({ kind: "ready" });
    expect(first.getView).toHaveBeenCalledTimes(4);
    again.unmount();
    other.unmount();
  });
});

describe("Bot 状态共享读取", () => {
  function botServices() {
    const listeners = new Set<(message: { channel: string }) => void>();
    const getBotStates = vi.fn(async () => [
      {
        botId: "bot",
        workspacePath: "/w",
        activeTaskId: "task-1",
        group: { taskIds: ["task-1", "task-2"], inputs: { a: { source: { provider: "feishu" } } } },
      },
    ]);
    const onMessage = vi.fn((listener: (message: { channel: string }) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    });
    servicesRef.current = {
      botsService: { getBotStates, getConfig: vi.fn() },
      broadcastService: { onMessage },
    };
    return {
      getBotStates,
      onMessage,
      broadcast(channel: string) {
        for (const listener of listeners) listener({ channel });
      },
      listenerCount: () => listeners.size,
    };
  }

  it("WR01/WR02：多个面板只读一次、只订阅一次广播；群状态广播后只重读一次；草稿不读取", async () => {
    const bots = botServices();
    const panes = renderHook(() => [
      useBotGroupTask("task-1", "/w"),
      useBotGroupTask("task-2", "/w"),
      useBotGroupTask("task-1", "/w"),
      useBotGroupTask(null, "/w"),
    ]);
    await waitFor(() =>
      expect(panes.result.current.slice(0, 3).every((pane) => pane.context?.botId === "bot")).toBe(
        true,
      ),
    );
    // 修复前：3 次读取、4 个广播订阅。
    expect(bots.getBotStates).toHaveBeenCalledTimes(1);
    expect(bots.listenerCount()).toBe(1);

    await act(async () => bots.broadcast("bots:group-state"));
    await waitFor(() => expect(bots.getBotStates).toHaveBeenCalledTimes(2));
    await act(async () => bots.broadcast("other-channel"));
    expect(bots.getBotStates).toHaveBeenCalledTimes(2);
    panes.unmount();
    expect(bots.listenerCount()).toBe(0);
  });
});

describe("外部引擎连接配置共享读取", () => {
  function connectionsView(defaultProfile: string): ExternalEngineConnectionsView {
    return {
      profiles: [],
      defaults: { "claude-code": defaultProfile, codex: "codex-cli" },
    } as unknown as ExternalEngineConnectionsView;
  }

  it("WR01/WR02/WR04：多个面板只读一次；广播直接更新全部实例；设置页刷新发新请求", async () => {
    const emitter = new Emitter<ExternalEngineConnectionsView>();
    const getConnectionProfiles = vi.fn(async () => connectionsView("first"));
    const service = {
      getConnectionProfiles,
      onConnectionProfilesChanged: emitter.event,
    } as unknown as ExternalEngineServiceHandle;
    const panes = renderHook(() => [
      useEngineConnectionProfiles(service),
      useEngineConnectionProfiles(service),
      useEngineConnectionProfiles(service),
    ]);
    await waitFor(() =>
      expect(panes.result.current.every((pane) => pane.connections !== null)).toBe(true),
    );
    // 修复前：3 次。
    expect(getConnectionProfiles).toHaveBeenCalledTimes(1);

    act(() => emitter.fire(connectionsView("second")));
    expect(
      panes.result.current.every((pane) => pane.connections?.defaults["claude-code"] === "second"),
    ).toBe(true);
    expect(getConnectionProfiles).toHaveBeenCalledTimes(1);

    const late = renderHook(() => useEngineConnectionProfiles(service));
    await waitFor(() =>
      expect(late.result.current.connections?.defaults["claude-code"]).toBe("second"),
    );
    expect(getConnectionProfiles).toHaveBeenCalledTimes(1);

    await act(async () => {
      await late.result.current.refresh();
    });
    expect(getConnectionProfiles).toHaveBeenCalledTimes(2);
    late.unmount();
    panes.unmount();
  });
});
