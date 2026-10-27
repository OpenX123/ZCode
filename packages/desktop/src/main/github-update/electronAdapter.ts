import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import { createGithubDesktopUpdater } from "./updater.js";

/** 仅应用自己的顶层 Renderer 可请求更新，内嵌网页和子 frame 无权打开安装器。 */
function assertApplicationSender(event: IpcMainInvokeEvent): void {
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("更新操作仅允许应用窗口发起");
  }
}

export function installGithubDesktopUpdates(): () => void {
  const updater = createGithubDesktopUpdater({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    cacheDir: join(app.getPath("userData"), "github-updates"),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    openInstaller: (path) => shell.openPath(path),
  });
  const handlers = [
    [PlatformChannels.GetUpdateState, () => updater.getState()],
    [PlatformChannels.CheckForUpdates, () => updater.checkForUpdates(true)],
    [PlatformChannels.DownloadUpdate, () => updater.downloadUpdate()],
    [PlatformChannels.InstallUpdate, () => updater.installUpdate()],
  ] as const;
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, (event) => {
      assertApplicationSender(event);
      return handler();
    });
  }
  const unsubscribe = updater.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(PlatformChannels.UpdateState, state);
      }
    }
  });
  const resume = () => {
    void updater.checkForUpdates(false);
  };
  powerMonitor.on("resume", resume);
  updater.start();
  return () => {
    updater.dispose();
    unsubscribe();
    powerMonitor.removeListener("resume", resume);
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
