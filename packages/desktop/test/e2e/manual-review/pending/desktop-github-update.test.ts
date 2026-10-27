import { join } from "node:path";
import { TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver, waitForDefaultWorkspaceReady } from "../../helpers/desktop-app.js";

/** 仅替换测试进程更新 IPC；不联网、不打开真实安装器。 */
describe("GitHub 桌面更新入口", () => {
  it("从帮助检查到下载进度、错误重试、已下载重开安装包", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await browser.electron.execute((electron) => {
      const ipc = electron.ipcMain;
      const calls = { check: 0, download: 0, install: 0 };
      const globals = globalThis as typeof globalThis & {
        __updateTestCalls?: typeof calls;
        __updateTestHandlers?: Map<string, unknown>;
      };
      globals.__updateTestCalls = calls;
      // Electron 不提供 handler 读取 API；保存现有处理器，测试结束后原样恢复。
      const handlers = (ipc as typeof ipc & { _invokeHandlers: Map<string, unknown> })
        ._invokeHandlers;
      globals.__updateTestHandlers = new Map();
      for (const channel of [
        "zcode:check-for-updates",
        "zcode:download-update",
        "zcode:install-update",
      ]) {
        globals.__updateTestHandlers.set(channel, handlers.get(channel));
        ipc.removeHandler(channel);
      }
      const send = (state: Record<string, unknown>) => {
        for (const win of electron.BrowserWindow.getAllWindows())
          win.webContents.send("zcode:update-state", { enabled: true, ...state });
      };
      ipc.handle("zcode:check-for-updates", () => {
        calls.check++;
        send({ kind: "update-available", version: "1.0.1" });
        return { kind: "available", version: "1.0.1" };
      });
      ipc.handle("zcode:download-update", () => {
        calls.download++;
        send({ kind: "download-progress", version: "1.0.1", progress: "37%" });
        return { kind: "downloading", version: "1.0.1" };
      });
      ipc.handle("zcode:install-update", () => {
        calls.install++;
        return { kind: "ready", version: "1.0.1" };
      });
    });
    try {
      await browser.electron.execute((electron) => {
        for (const win of electron.BrowserWindow.getAllWindows())
          win.webContents.send("zcode:update-state", {
            kind: "error",
            enabled: true,
            message: "更新检查失败：HTTP 404",
          });
      });
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      await expect($('[data-testid="desktop-update-action"]')).not.toExist();
      await clickTestIdByWebDriver(TID_WORKSPACE_HELP_MENU_TRIGGER);
      await clickTestIdByWebDriver("workspace-help-menu-check-updates");
      const action = $('[data-testid="desktop-update-action"]');
      await expect(action).toHaveText(expect.stringContaining("1.0.1"));
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "desktop-update-available.png"),
      );
      await action.click();
      await expect(action).toBeDisabled();
      await expect($('[role="progressbar"]')).toHaveAttribute("aria-valuenow", "37");
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "desktop-update-progress.png"),
      );
      await browser.electron.execute((electron) => {
        for (const win of electron.BrowserWindow.getAllWindows())
          win.webContents.send("zcode:update-state", {
            kind: "error",
            enabled: true,
            version: "1.0.1",
            message: "E2E checksum mismatch",
          });
      });
      await expect($('[data-testid="desktop-update-status"]')).toHaveText("E2E checksum mismatch");
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "desktop-update-error.png"),
      );
      await action.click();
      await expect(action).toBeDisabled();
      await browser.electron.execute((electron) => {
        for (const win of electron.BrowserWindow.getAllWindows())
          win.webContents.send("zcode:update-state", {
            kind: "update-downloaded",
            enabled: true,
            version: "1.0.1",
          });
      });
      await expect(action).toBeEnabled();
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "desktop-update-ready.png"),
      );
      await action.click();
      const calls = await browser.electron.execute(
        () =>
          (
            globalThis as typeof globalThis & {
              __updateTestCalls?: { check: number; download: number; install: number };
            }
          ).__updateTestCalls,
      );
      expect(calls).toEqual({ check: 1, download: 2, install: 1 });
    } finally {
      await browser.electron.execute((electron) => {
        const globals = globalThis as typeof globalThis & {
          __updateTestCalls?: unknown;
          __updateTestHandlers?: Map<string, Parameters<typeof electron.ipcMain.handle>[1]>;
        };
        for (const [channel, handler] of globals.__updateTestHandlers ?? []) {
          electron.ipcMain.removeHandler(channel);
          if (handler) electron.ipcMain.handle(channel, handler);
        }
        delete globals.__updateTestCalls;
        delete globals.__updateTestHandlers;
        for (const win of electron.BrowserWindow.getAllWindows())
          win.webContents.send("zcode:update-state", { kind: "idle", enabled: false });
      });
    }
  });
});
