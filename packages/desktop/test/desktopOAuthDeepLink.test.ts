import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const electronMocks = vi.hoisted(() => ({
  appShow: vi.fn(),
  showMessageBoxSync: vi.fn(() => 0),
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
  setAsDefaultProtocolClient: vi.fn(() => true),
}));
const fsMocks = vi.hoisted(() => ({
  statSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.statSync.mockImplementation(actual.statSync);
  return {
    ...actual,
    statSync: fsMocks.statSync,
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    get isPackaged() {
      return false;
    },
    setAsDefaultProtocolClient: electronMocks.setAsDefaultProtocolClient,
    show: electronMocks.appShow,
  },
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
    getAllWindows: electronMocks.getAllWindows,
  },
  dialog: {
    showMessageBoxSync: electronMocks.showMessageBoxSync,
  },
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  electronMocks.appShow.mockClear();
  electronMocks.showMessageBoxSync.mockReset();
  electronMocks.showMessageBoxSync.mockReturnValue(0);
  electronMocks.getFocusedWindow.mockReset();
  electronMocks.getAllWindows.mockReset();
  electronMocks.setAsDefaultProtocolClient.mockClear();
  fsMocks.statSync.mockClear();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktopOAuthDeepLink workspace open routing", () => {
  it("缓存冷启动时命中未就绪窗口的 workspace open 请求，等 renderer ready 后再投递", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(7);
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger);

    expect(handled).toBe(true);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[deep-link] 工作区打开请求命中未就绪窗口，先缓存等待 renderer ready",
      { windowId: 7, path: workspacePath },
    );
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalled();

    deliverPendingDeepLink(targetWindow.webContents);

    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
  });

  it("renderer ready 后收到 workspace open 请求时立即投递", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(11);
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger);

    expect(handled).toBe(true);
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalled();
  });

  it("工作区打开路由使用业务窗口解析器，不会选中 CUA 辅助浮层", async () => {
    const workspacePath = createTempWorkspace();
    const cuaIndicatorWindow = createMockWindow(12);
    const applicationWindow = createMockWindow(13);
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(null);
    electronMocks.getAllWindows.mockReturnValue([cuaIndicatorWindow, applicationWindow]);

    const { deliverPendingDeepLink, handleOpenWorkspacePath } =
      await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(applicationWindow.webContents);

    expect(
      handleOpenWorkspacePath(workspacePath, logger, {
        resolveApplicationWindow: () => applicationWindow,
      }),
    ).toBe(true);
    expect(applicationWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
    expect(cuaIndicatorWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("workspace open 确认弹窗使用调用方注入的 locale 文案", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(21);
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const { deliverPendingDeepLink, handleDeepLink, resolveExternalWorkspaceOpenDialogCopy } =
      await import("../src/main/desktopOAuthDeepLink.js");

    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger, {
      confirmationCopy: resolveExternalWorkspaceOpenDialogCopy("zh-CN"),
    });

    expect(handled).toBe(true);
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalledWith(
      targetWindow,
      expect.objectContaining({
        buttons: ["打开文件夹", "取消"],
        title: "打开外部 YCode 链接？",
      }),
    );
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
  });

  it("没有父窗口时 workspace open 确认弹窗仍同步阻塞并缓存请求", async () => {
    const workspacePath = createTempWorkspace();
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(null);
    electronMocks.getAllWindows.mockReturnValue([]);

    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger);

    expect(handled).toBe(false);
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["Open folder", "Cancel"],
        title: "Open external YCode link?",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[deep-link] 工作区打开请求暂未命中窗口，先缓存等待 renderer ready",
      { path: workspacePath },
    );

    const targetWindow = createMockWindow(22);
    deliverPendingDeepLink(targetWindow.webContents);
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
  });

  it("没有父窗口且用户取消时不缓存 workspace open 请求", async () => {
    const workspacePath = createTempWorkspace();
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.showMessageBoxSync.mockReturnValue(1);
    electronMocks.getFocusedWindow.mockReturnValue(null);
    electronMocks.getAllWindows.mockReturnValue([]);

    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger);

    expect(handled).toBe(true);
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalledWith(expect.any(Object));
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 用户取消打开外部链接工作区", {
      path: workspacePath,
    });

    const targetWindow = createMockWindow(23);
    deliverPendingDeepLink(targetWindow.webContents);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("用户取消 deep link 确认时不投递 workspace open 请求", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(12);
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.showMessageBoxSync.mockReturnValue(1);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger);

    expect(handled).toBe(true);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 用户取消打开外部链接工作区", {
      path: workspacePath,
    });
  });

  it.each([
    ["标准 UNC", "\\\\attacker\\share"],
    ["正斜杠 UNC", "//attacker/share"],
    ["extended UNC", "\\\\?\\UNC\\attacker\\share"],
  ])("拒绝 %s workspace deep link，且拒绝前不触碰文件系统", async (_label, workspacePath) => {
    const targetWindow = createMockWindow(14);
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const { handleDeepLink } = await import("../src/main/desktopOAuthDeepLink.js");

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger);

    expect(handled).toBe(false);
    expect(fsMocks.statSync).not.toHaveBeenCalled();
    expect(electronMocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 网络工作区路径已拒绝", {
      path: workspacePath,
    });
  });

  it("没有就绪窗口时默认不缓存 workspace open 请求", async () => {
    const workspacePath = createTempWorkspace();
    const logger = { info: vi.fn(), warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(null);
    electronMocks.getAllWindows.mockReturnValue([]);

    const { deliverPendingDeepLink, handleOpenWorkspacePath } =
      await import("../src/main/desktopOAuthDeepLink.js");

    const handled = handleOpenWorkspacePath(workspacePath, logger);

    expect(handled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 工作区打开请求暂未命中窗口，已忽略", {
      path: workspacePath,
    });

    const targetWindow = createMockWindow(13);
    deliverPendingDeepLink(targetWindow.webContents);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("workspace open 被 gate 阻止时不缓存也不投递", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(17);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onWorkspaceOpenBlocked = vi.fn();
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    const handled = handleDeepLink(buildWorkspaceOpenUrl(workspacePath), logger, {
      canOpenWorkspace: () => false,
      onWorkspaceOpenBlocked,
    });

    expect(handled).toBe(true);
    expect(onWorkspaceOpenBlocked).toHaveBeenCalledWith(workspacePath);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 工作区打开请求被当前启动 gate 阻止", {
      path: workspacePath,
    });

    deliverPendingDeepLink(targetWindow.webContents);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });
});

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-workspace-open-"));
  tempDirs.push(dir);
  return dir;
}

function createMockWindow(webContentsId: number) {
  return {
    webContents: {
      id: webContentsId,
      send: vi.fn(),
    },
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
  };
}

function buildWorkspaceOpenUrl(workspacePath: string): string {
  return `zcode://workspace/open?path=${encodeURIComponent(workspacePath)}`;
}
