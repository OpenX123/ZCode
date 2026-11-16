import { describe, expect, it, vi, beforeEach } from "vitest";
import { DesktopCommandIds, PlatformChannels } from "@zcode/shared";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { interruptedCacheLockFixture } from "./helpers/sourceServerCacheLockFixture.js";

type IpcHandler = (...args: unknown[]) => unknown;

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    openPath: vi.fn(async () => ""),
    openCuaPermissionOnboarding: vi.fn(),
    // 拖拽授权引导的 helper 预校验：本文件只覆盖 platform IPC 注册，不验证 helper
    // 缓存路径，所以固定返回失败结果走 clearVerifiedHelper 分支。必须返回对象——
    // 调用方 refreshVerifiedHelperAppPath 直接读 result.success。
    prepareCuaHelperPermissionDrag: vi.fn(async () => ({
      success: false as const,
      error: "prepareCuaHelperPermissionDrag is not exercised in platform IPC tests",
    })),
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(),
    ipcHandle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    ipcOn: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    browserWindowFromWebContents: vi.fn(() => null),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electronMocks.browserWindowFromWebContents,
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showMessageBox: electronMocks.showMessageBox,
  },
  ipcMain: {
    handle: electronMocks.ipcHandle,
    on: electronMocks.ipcOn,
  },
  nativeTheme: {
    themeSource: "system",
  },
  nativeImage: {},
  shell: {
    openPath: electronMocks.openPath,
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../src/main/editors.js", () => ({
  getInstalledEditors: vi.fn(() => []),
}));

vi.mock("../src/main/exportLogs.js", () => ({
  exportLogs: vi.fn(),
}));

vi.mock("../src/main/desktopCommandHandlers.js", () => ({
  resolveCommunityUrl: vi.fn(() => "https://example.com"),
}));

vi.mock("../src/main/openInEditor.js", () => ({
  openInEditor: vi.fn(),
}));

vi.mock("../src/main/resourceManagerWindow.js", () => ({
  getResourceUsageSnapshot: vi.fn(),
  setResourceUsageSamplingActive: vi.fn(),
  openResourceManager: vi.fn(),
}));

vi.mock("../src/main/desktopWindowChrome.js", () => ({
  applyWindowsTitleBarTheme: vi.fn(),
  getWindowOverlayTheme: vi.fn(() => null),
}));

vi.mock("../src/main/desktopWindowLifecycle.js", () => ({
  handleWindowUnreadCountSync: vi.fn(),
}));

vi.mock("../src/main/desktopWindowButtonPosition.js", () => ({
  syncWindowControlsOverlayForZoomLevel: vi.fn(),
}));

vi.mock("../src/main/mcpUserDirectory/index.js", () => ({
  loadCliMcpFromUserDirectory: vi.fn(),
  migrateLegacyCommonMcp: vi.fn(),
  saveCliMcpToUserDirectory: vi.fn(),
}));

vi.mock("../src/main/cuaAccessibilitySettings.js", () => ({
  openCuaPermissionOnboarding: electronMocks.openCuaPermissionOnboarding,
  prepareCuaHelperPermissionDrag: electronMocks.prepareCuaHelperPermissionDrag,
}));

describe("registerPlatformIpcHandlers", () => {
  it("缓存恢复允许配置 root 自身 canonical 化，原生抛错和缺配置安全失败", async () => {
    const fixture = await interruptedCacheLockFixture();
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    const logger = { info: vi.fn(), warn: vi.fn() };
    try {
      const alias = join(fixture.root, "cache-alias");
      await symlink(
        fixture.remoteCacheDir,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      registerPlatformIpcHandlers({
        logger,
        resolveRemoteAssetDirs: () => ({ remoteCacheDir: alias }),
      } as never);
      let handler = electronMocks.handlers.get(
        PlatformChannels.OpenSourceServerCacheRecoveryDirectory,
      )!;
      await expect(handler({}, fixture.recovery)).resolves.toEqual({ success: true });
      expect(electronMocks.openPath).toHaveBeenLastCalledWith(await realpath(fixture.contentDir));
      electronMocks.openPath.mockRejectedValueOnce(
        new Error(`${fixture.root} ${fixture.recovery.sha256}`),
      );
      const failure = await handler({}, fixture.recovery);
      expect(failure).toMatchObject({ success: false });
      expect(
        JSON.stringify([failure, logger.info.mock.calls, logger.warn.mock.calls]),
      ).not.toContain(fixture.root);
      expect(
        JSON.stringify([failure, logger.info.mock.calls, logger.warn.mock.calls]),
      ).not.toContain(fixture.recovery.sha256);
      registerPlatformIpcHandlers({ logger } as never);
      handler = electronMocks.handlers.get(
        PlatformChannels.OpenSourceServerCacheRecoveryDirectory,
      )!;
      await expect(handler({}, fixture.recovery)).resolves.toMatchObject({ success: false });
      expect(electronMocks.openPath).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.dispose();
    }
  });
  it.each([1, 2, 3])(
    "缓存恢复拒绝 root 下第 %s 层链接与具有 root 前缀的越界目录",
    async (depth) => {
      const fixture = await interruptedCacheLockFixture();
      const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
      try {
        const segments = ["source-server", fixture.recovery.version, fixture.recovery.target];
        const linkPath = join(fixture.remoteCacheDir, ...segments.slice(0, depth));
        const collision = `${fixture.remoteCacheDir}-outside`;
        await rename(linkPath, collision);
        await symlink(collision, linkPath, process.platform === "win32" ? "junction" : "dir");
        registerPlatformIpcHandlers({
          logger: { info: vi.fn(), warn: vi.fn() },
          resolveRemoteAssetDirs: () => ({ remoteCacheDir: fixture.remoteCacheDir }),
        } as never);
        const handler = electronMocks.handlers.get(
          PlatformChannels.OpenSourceServerCacheRecoveryDirectory,
        )!;
        await expect(handler({}, fixture.recovery)).resolves.toMatchObject({ success: false });
        expect(electronMocks.openPath).not.toHaveBeenCalled();
      } finally {
        await fixture.dispose();
      }
    },
  );
  it("缓存恢复实际 IPC 只打开覆盖 root 的精确 SHA，拒绝伪造与链接且不泄露原生错误", async () => {
    const fixture = await interruptedCacheLockFixture();
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    const logger = { info: vi.fn(), warn: vi.fn() };
    registerPlatformIpcHandlers({
      logger,
      resolveRemoteAssetDirs: () => ({ remoteCacheDir: fixture.remoteCacheDir }),
    } as never);
    const handler = electronMocks.handlers.get("zcode:open-source-server-cache-recovery-directory");
    try {
      expect(handler).toBeTypeOf("function");
      const other = join(
        fixture.contentDir,
        "..",
        "b".repeat(64),
        "zcode-server-linux-x64.tar.gz.lock",
      );
      await mkdir(other, { recursive: true });
      await writeFile(join(other, "owner.json"), "other-sha");
      electronMocks.openPath.mockReset().mockResolvedValue("");
      await expect(handler?.({}, fixture.recovery)).resolves.toEqual({ success: true });
      expect(electronMocks.openPath).toHaveBeenLastCalledWith(await realpath(fixture.contentDir));
      expect(await readFile(join(other, "owner.json"), "utf8")).toBe("other-sha");
      for (const invalid of [
        { ...fixture.recovery, path: fixture.root },
        { ...fixture.recovery, version: "../escape" },
        { ...fixture.recovery, version: "0.0.0" },
        { ...fixture.recovery, target: "../linux-x64" },
        { ...fixture.recovery, sha256: "../" },
      ]) {
        await expect(handler?.({}, invalid)).resolves.toMatchObject({ success: false });
      }
      expect(electronMocks.openPath).toHaveBeenCalledTimes(1);
      electronMocks.openPath.mockResolvedValue(`native ${fixture.root} ${fixture.recovery.sha256}`);
      const failure = await handler?.({}, fixture.recovery);
      expect(failure).toMatchObject({ success: false });
      expect(
        JSON.stringify([failure, logger.info.mock.calls, logger.warn.mock.calls]),
      ).not.toContain(fixture.root);
      expect(
        JSON.stringify([failure, logger.info.mock.calls, logger.warn.mock.calls]),
      ).not.toContain(fixture.recovery.sha256);
      await rm(fixture.lockDir, { recursive: true });
      await expect(handler?.({}, fixture.recovery)).resolves.toMatchObject({ success: false });
      await writeFile(fixture.lockDir, "not-directory");
      await expect(handler?.({}, fixture.recovery)).resolves.toMatchObject({ success: false });
      await rm(fixture.lockDir);
      await symlink(other, fixture.lockDir, process.platform === "win32" ? "junction" : "dir");
      await expect(handler?.({}, fixture.recovery)).resolves.toMatchObject({ success: false });
      await rm(fixture.lockDir);
      await rm(fixture.contentDir, { recursive: true });
      await symlink(
        join(other, ".."),
        fixture.contentDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(handler?.({}, fixture.recovery)).resolves.toMatchObject({ success: false });
      expect(electronMocks.openPath).toHaveBeenCalledTimes(2);
      expect(await readFile(join(other, "owner.json"), "utf8")).toBe("other-sha");
    } finally {
      await fixture.dispose();
    }
  });
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.openPath.mockReset().mockResolvedValue("");
    electronMocks.openCuaPermissionOnboarding.mockReset();
    electronMocks.showOpenDialog.mockReset();
    electronMocks.showMessageBox.mockReset();
    electronMocks.ipcHandle.mockClear();
    electronMocks.ipcOn.mockClear();
    electronMocks.browserWindowFromWebContents.mockReset();
    electronMocks.browserWindowFromWebContents.mockReturnValue(null);
  });

  it("allows creating folders from the workspace directory picker", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");

    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      deviceMid: "test-device-mid",
    });

    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/new-workspace"],
    });

    const handler = electronMocks.handlers.get(PlatformChannels.SelectDirectory);
    expect(handler).toBeDefined();
    await handler?.();

    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory"],
    });
  });

  it("returns every native directory selection and an empty list on cancellation", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      deviceMid: "test-device-mid",
    });
    const handler = electronMocks.handlers.get(PlatformChannels.SelectDirectories);
    expect(handler).toBeDefined();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/one", "/two"],
    });
    await expect(handler?.()).resolves.toEqual(["/one", "/two"]);
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ["/ignored"] });
    await expect(handler?.()).resolves.toEqual([]);
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(handler?.()).resolves.toEqual([]);
  });

  it("syncs macOS window controls when preload reports startup zoom metrics", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    const { syncWindowControlsOverlayForZoomLevel } =
      await import("../src/main/desktopWindowButtonPosition.js");

    const targetWindow = { id: 1 };
    electronMocks.browserWindowFromWebContents.mockReturnValue(targetWindow);

    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      deviceMid: "test-device-mid",
    });

    const handler = electronMocks.handlers.get(PlatformChannels.WindowControlsOverlayReady);
    expect(handler).toBeDefined();
    handler?.(
      { sender: {} },
      {
        zoomLevel: 2,
        metrics: { leftPaddingPx: 79 },
      },
    );

    expect(syncWindowControlsOverlayForZoomLevel).toHaveBeenCalledWith(targetWindow, 2);
  });

  it("runs generalized CUA permission onboarding for Screen Recording", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");

    electronMocks.openCuaPermissionOnboarding.mockResolvedValueOnce({
      success: true,
      sessionId: "session-1",
      returnedFromSettings: true,
    });
    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      deviceMid: "test-device-mid",
    });

    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const handler = electronMocks.handlers.get(PlatformChannels.OpenCuaPermissionOnboarding);
    expect(handler).toBeDefined();

    await expect(
      handler?.(
        { sender: {} },
        {
          initialPermission: "screen_recording",
          requiredPermissions: ["screen_recording"],
          // 旧 renderer 即使传入未知 alias，main 也不能再转发或回显它们。
          prepareAllRequired: true,
          missingPermissions: ["accessibility"],
        },
      ),
    ).resolves.toEqual({
      success: true,
      sessionId: "session-1",
      returnedFromSettings: true,
    });
    expect(electronMocks.openCuaPermissionOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPermission: "screen_recording",
        requiredPermissions: ["screen_recording"],
        logger: { info: expect.any(Function), warn: expect.any(Function) },
        signal: expect.any(AbortSignal),
        openSettingsAndWaitForReturn: expect.any(Function),
      }),
    );
    expect(electronMocks.openCuaPermissionOnboarding).not.toHaveBeenCalledWith(
      expect.objectContaining({
        prepareAllRequired: expect.anything(),
        missingPermissions: expect.anything(),
      }),
    );
  });

  it("returns desktop command results to the renderer", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    const executeDesktopCommand = vi.fn(async () => ({ kind: "supported" }));

    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand,
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      deviceMid: "test-device-mid",
    });

    const handler = electronMocks.handlers.get(PlatformChannels.ExecuteDesktopCommand);
    expect(handler).toBeDefined();

    await expect(handler?.({ sender: {} }, DesktopCommandIds.GetCuaOsSupport)).resolves.toEqual({
      kind: "supported",
    });
    expect(executeDesktopCommand).toHaveBeenCalledWith(DesktopCommandIds.GetCuaOsSupport, null);
  });
});
