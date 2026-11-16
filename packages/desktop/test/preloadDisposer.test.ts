import { InternalChannels, PlatformChannels, type UpdateStatePayload } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRemoteWorkspaceServicePortMessage } from "../src/renderer/src/remoteWorkspaceServicePortBridge.js";

/**
 * 验证 preload bridge 中 onFocusTab / onNewTab / onOpenBrowserUrl / onNewTask / onOpenWorkspace
 * 返回 disposer，调用 disposer 后 ipcRenderer 监听器被正确移除。
 *
 * 因为 preload/index.ts 在模块加载时就调用 contextBridge.exposeInMainWorld，
 * 我们 mock electron 模块，拦截 exposeInMainWorld 的参数来获取暴露的 API。
 */

// 模拟 ipcRenderer 的 on / removeListener
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

const mockIpcSend = vi.fn();
const mockIpcRenderer = {
  on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(handler);
  }),
  removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
    listeners.get(channel)?.delete(handler);
  }),
  send: mockIpcSend,
  invoke: vi.fn(),
};
const mockWebFrame = {
  getZoomFactor: vi.fn(() => 1),
};

let exposedApi: Record<string, (...args: unknown[]) => unknown> = {};
const originalPlatform = process.platform;

function stubProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

vi.mock("electron", () => ({
  contextBridge: {
    // preload 还会暴露插件 UI 沙箱的 zcodePluginSandbox；这里只截获 window.zcode 本身。
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
      if (name === "zcode") exposedApi = api as Record<string, (...args: unknown[]) => unknown>;
    },
    executeInMainWorld: () => false,
  },
  ipcRenderer: mockIpcRenderer,
  webFrame: mockWebFrame,
}));

// 模拟 document.title（updateRendererProcessTitle 需要）
vi.stubGlobal("document", { title: "test" });
vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  postMessage: vi.fn(),
});

afterEach(() => {
  stubProcessPlatform(originalPlatform);
});

beforeEach(() => {
  listeners.clear();
  mockIpcRenderer.on.mockClear();
  mockIpcRenderer.removeListener.mockClear();
  mockIpcSend.mockClear();
  mockIpcRenderer.invoke.mockReset();
  mockWebFrame.getZoomFactor.mockClear();
  mockWebFrame.getZoomFactor.mockReturnValue(1);
  vi.mocked(window.addEventListener).mockClear();
  exposedApi = {};
});

describe("preload IPC disposer", () => {
  // 每个测试动态 import 以触发模块初始化
  async function loadPreload() {
    // 清除缓存以重新执行模块
    vi.resetModules();
    await import("../src/preload/index.js");
    return exposedApi;
  }

  it("preload 初始化时会上报当前窗口控制区 zoom 信息", async () => {
    stubProcessPlatform("darwin");
    mockWebFrame.getZoomFactor.mockReturnValue(1.21);

    await loadPreload();

    expect(mockIpcSend).toHaveBeenCalledWith("zcode:window-controls-overlay-ready", {
      zoomLevel: 2,
      metrics: { leftPaddingPx: 79 },
    });
  });

  it("Windows preload 初始化时会上报反向补偿后的右侧安全区", async () => {
    stubProcessPlatform("win32");
    mockWebFrame.getZoomFactor.mockReturnValue(1.21);

    await loadPreload();

    expect(mockIpcSend).toHaveBeenCalledWith("zcode:window-controls-overlay-ready", {
      zoomLevel: 2,
      metrics: { rightPaddingPx: 112, titleBarHeightPx: 58 },
    });
  });

  it("把 renderer 的 scoped attachment ready ACK 转发给 Main", async () => {
    await loadPreload();
    const messageHandler = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === "message")?.[1] as EventListener | undefined;
    expect(messageHandler).toBeDefined();

    messageHandler?.({
      source: window,
      data: {
        type: InternalChannels.ScopedServicePortReady,
        sessionId: "remote-session-1",
        attachmentId: "attachment-b",
      },
    } as unknown as Event);

    expect(mockIpcSend).toHaveBeenCalledWith(InternalChannels.ScopedServicePortReady, {
      sessionId: "remote-session-1",
      attachmentId: "attachment-b",
    });
  });

  it("把 Main 的完整 remote workspace scope 转发给 Renderer", async () => {
    await loadPreload();
    const scopedPortHandler = Array.from(
      listeners.get(InternalChannels.ScopedServicePort) ?? [],
    ).at(-1);
    expect(scopedPortHandler).toBeDefined();

    const port = {} as MessagePort;
    const payload = {
      attachmentId: "attachment-project",
      sessionId: "project-session",
      target: { kind: "docker", container: "dev" } as const,
      sourceServerId: "source-1",
      workspacePath: "/remote/project",
      workspaceIdentity: "remote:server:source-1:/remote/project",
      workspacePurpose: "project" as const,
    };

    scopedPortHandler?.({ ports: [port] }, payload);

    expect(window.postMessage).toHaveBeenCalledWith(
      {
        type: InternalChannels.ScopedServicePort,
        ...payload,
      },
      "*",
      [port],
    );
    const forwardedMessage = vi
      .mocked(window.postMessage)
      .mock.calls.find(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === InternalChannels.ScopedServicePort,
      )?.[0];
    expect(
      parseRemoteWorkspaceServicePortMessage({
        data: forwardedMessage,
        ports: [port],
      } as unknown as MessageEvent),
    ).toEqual({
      ...payload,
      port,
    });
  });

  it("onNewTab 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onNewTab(callback) as () => void;
    expect(typeof dispose).toBe("function");
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("onOpenBrowserUrl 返回 disposer 并转发 webview 新页面请求", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onOpenBrowserUrl(callback) as () => void;
    expect(typeof dispose).toBe("function");

    const handlers = Array.from(listeners.get(PlatformChannels.OpenBrowserUrl) ?? []);
    expect(handlers.length).toBe(1);
    handlers[0]?.({}, { disposition: "new-window", url: "https://example.com" });

    expect(callback).toHaveBeenCalledWith({
      disposition: "new-window",
      url: "https://example.com",
    });

    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      handlers[0],
    );
  });

  it("browser screenshot surface bridge 转发 prepare/release，并用 send 上报 ready", async () => {
    const api = await loadPreload();
    const prepare = vi.fn();
    const release = vi.fn();
    const disposePrepare = api.onBrowserViewScreenshotSurfacePrepare(prepare) as () => void;
    const prepareHandler = Array.from(
      listeners.get(PlatformChannels.BrowserViewScreenshotSurfacePrepare) ?? [],
    ).at(-1);
    expect(prepareHandler).toBeDefined();
    const disposeRelease = api.onBrowserViewScreenshotSurfaceRelease(release) as () => void;
    const releaseHandler = Array.from(
      listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceRelease) ?? [],
    ).at(-1);
    expect(releaseHandler).toBeDefined();
    const payload = {
      requestId: "shot-1",
      workspaceKey: "remote:ssh:dev:/repo",
      sessionId: "sess-1",
      browserId: "browser-1",
      browserGeneration: 3,
      tabId: "tab-1",
      webContentsId: 42,
      viewport: { width: 1274, height: 720 },
    };

    prepareHandler?.({}, payload);
    const { viewport: _viewport, ...releasePayload } = payload;
    releaseHandler?.({}, releasePayload);
    const readyPayload = { ...payload, surfaceScale: 0.625 };
    api.browserViewScreenshotSurfaceReady(readyPayload);

    expect(prepare).toHaveBeenCalledWith(payload);
    expect(release).toHaveBeenCalledWith(releasePayload);
    expect(mockIpcSend).toHaveBeenCalledWith(
      PlatformChannels.BrowserViewScreenshotSurfaceReady,
      readyPayload,
    );

    disposePrepare();
    disposeRelease();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      PlatformChannels.BrowserViewScreenshotSurfacePrepare,
      prepareHandler,
    );
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      PlatformChannels.BrowserViewScreenshotSurfaceRelease,
      releaseHandler,
    );

    for (const handler of listeners.get(PlatformChannels.BrowserViewScreenshotSurfacePrepare) ??
      []) {
      handler({}, payload);
    }
    for (const handler of listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceRelease) ??
      []) {
      handler({}, releasePayload);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("onNewTask 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onNewTask(callback) as () => void;
    expect(typeof dispose).toBe("function");
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("onOpenWorkspace 返回 disposer，调用后移除 ipcRenderer 监听", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onOpenWorkspace(callback) as () => void;
    expect(typeof dispose).toBe("function");
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalled();
  });

  it("onOpenWorkspacePath 晚注册时会回放冷启动目录路径", async () => {
    const api = await loadPreload();
    const handlers = Array.from(listeners.get(PlatformChannels.OpenWorkspacePath) ?? []);
    expect(handlers.length).toBe(1);

    handlers[0]?.({}, "C:\\Users\\demo\\Project A");

    const callback = vi.fn();
    const dispose = api.onOpenWorkspacePath(callback) as () => void;
    expect(callback).toHaveBeenCalledWith("C:\\Users\\demo\\Project A");

    callback.mockClear();
    handlers[0]?.({}, "C:\\Users\\demo\\Project B");
    expect(callback).toHaveBeenCalledWith("C:\\Users\\demo\\Project B");

    callback.mockClear();
    dispose();
    handlers[0]?.({}, "C:\\Users\\demo\\Project C");
    expect(callback).not.toHaveBeenCalled();
  });

  it("syncWindowUnreadCount 会通过对应 IPC 频道上报当前窗口未读数", async () => {
    const api = await loadPreload();

    api.syncWindowUnreadCount(3);

    expect(mockIpcSend).toHaveBeenCalledWith(PlatformChannels.SyncWindowUnreadCount, 3);
  });

  it("onUpdateState 转发 Main 状态，dispose 精确移除监听且不再接收后续更新", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onUpdateState(callback) as () => void;
    expect(typeof dispose).toBe("function");

    const handlers = Array.from(listeners.get(PlatformChannels.UpdateState) ?? []);
    expect(handlers).toHaveLength(1);
    const payload: UpdateStatePayload = {
      kind: "update-available",
      enabled: true,
      version: "1.0.1",
    };
    handlers[0]?.({}, payload);
    expect(callback).toHaveBeenCalledExactlyOnceWith(payload);

    callback.mockClear();
    dispose();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(
      PlatformChannels.UpdateState,
      handlers[0],
    );
    expect(listeners.get(PlatformChannels.UpdateState)?.size).toBe(0);
    for (const handler of listeners.get(PlatformChannels.UpdateState) ?? []) {
      handler({}, { kind: "idle", enabled: true });
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("onUpdateState 晚注册不缓存或回放旧状态，仅接收注册后的 Main 事件", async () => {
    const api = await loadPreload();
    const first = vi.fn();
    const disposeFirst = api.onUpdateState(first) as () => void;
    const payload: UpdateStatePayload = {
      kind: "download-progress",
      enabled: true,
      version: "1.0.1",
      progress: "42",
    };
    for (const handler of listeners.get(PlatformChannels.UpdateState) ?? []) {
      handler({}, payload);
    }
    expect(first).toHaveBeenCalledExactlyOnceWith(payload);
    disposeFirst();

    const late = vi.fn();
    const disposeLate = api.onUpdateState(late) as () => void;
    expect(late).not.toHaveBeenCalled();
    expect(mockIpcRenderer.invoke).not.toHaveBeenCalled();
    const idle: UpdateStatePayload = { kind: "idle", enabled: true };
    for (const handler of listeners.get(PlatformChannels.UpdateState) ?? []) {
      handler({}, idle);
    }
    expect(late).toHaveBeenCalledExactlyOnceWith(idle);
    expect(first).toHaveBeenCalledTimes(1);
    disposeLate();
  });

  it("getUpdateState 每次返回 Main 响应，事件不会覆盖或缓存快照", async () => {
    const api = await loadPreload();
    const available: UpdateStatePayload = {
      kind: "update-available",
      enabled: true,
      version: "1.0.1",
    };
    const idle: UpdateStatePayload = { kind: "idle", enabled: true };
    mockIpcRenderer.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce(idle);

    expect(await api.getUpdateState()).toBe(available);
    const callback = vi.fn();
    const dispose = api.onUpdateState(callback) as () => void;
    expect(callback).not.toHaveBeenCalled();
    for (const handler of listeners.get(PlatformChannels.UpdateState) ?? []) {
      handler({}, available);
    }
    expect(await api.getUpdateState()).toBe(idle);

    expect(mockIpcRenderer.invoke.mock.calls).toEqual([
      [PlatformChannels.GetUpdateState],
      [PlatformChannels.GetUpdateState],
    ]);
    expect(callback).toHaveBeenCalledExactlyOnceWith(available);
    dispose();
  });

  it.each([
    "onUpdateReady",
    "onUpdateStateChanged",
    "onPostUpdateReleaseNotes",
    "acknowledgePostUpdateReleaseNotes",
  ])("实际 preload 不再暴露退役更新接口 %s", async (name) => {
    expect(await loadPreload()).not.toHaveProperty(name);
  });

  it("dispose 后回调不再被触发", async () => {
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = api.onFocusTab(callback) as () => void;

    // 获取注册的 handler
    const channel = mockIpcRenderer.on.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("focus"),
    );
    expect(channel).toBeDefined();

    // dispose 后，从 listeners set 中移除
    dispose();
    const handlersAfterDispose = listeners.get(channel![0] as string);
    // handler 应该已经被移除
    expect(handlersAfterDispose?.size ?? 0).toBe(0);
  });
});
