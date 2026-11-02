import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  powerMonitor,
  shell,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { dirname, join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import { createGithubDesktopUpdater } from "./updater.js";
import { installMacUpdate } from "./macInstaller.js";

/** 仅应用自己的顶层 Renderer 可请求更新，内嵌网页和子 frame 无权打开安装器。 */
function assertApplicationSender(event: IpcMainInvokeEvent): void {
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("更新操作仅允许应用窗口发起");
  }
}

export function installGithubDesktopUpdates(lifecycle: {
  confirmInstall(): boolean;
  quitForInstall(): Promise<void>;
}): () => void {
  // 成功交接后保留同一 flight，避免退出屏障期间的重复 IPC 再启动助手；取消与失败可重试。
  let installFlight: Promise<string> | undefined;
  let networkFlight: Promise<Session> | undefined;
  const updater = createGithubDesktopUpdater({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    cacheDir: join(app.getPath("userData"), "github-updates"),
    fetch: async (input, init) => {
      if (!networkFlight) {
        // 模型 API 的 defaultSession 默认强制直连，复用它会绕开系统代理并卡住 GitHub 下载。
        // 更新单独跟随系统网络，不能为修复下载而改变模型 API 或放宽 TLS 校验。
        const updateSession = session.fromPartition("ycode-github-updates");
        networkFlight = updateSession
          .setProxy({ mode: "system" })
          .then(() => updateSession)
          .catch((error: unknown) => {
            networkFlight = undefined;
            throw error;
          });
      }
      const updateSession = await networkFlight;
      return updateSession.fetch(input instanceof URL ? input.href : input, init);
    },
    openInstaller: (path, version, signal) => {
      if (process.platform !== "darwin") return shell.openPath(path);
      if (installFlight) return installFlight;
      installFlight = installMacUpdate({
        appPath: dirname(dirname(dirname(process.execPath))),
        version,
        installerPath: path,
        logPath: join(app.getPath("userData"), "github-updates", "install.log"),
        signal,
        ...lifecycle,
      })
        .then((installed) => {
          if (!installed) installFlight = undefined;
          return "";
        })
        .catch((error: unknown) => {
          installFlight = undefined;
          throw error;
        });
      return installFlight;
    },
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
