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
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import type { GithubDesktopInstallMode, GithubDesktopUpdatePreferences } from "./contract.js";
import { createGithubDesktopUpdater } from "./updater.js";
import { installMacUpdate } from "./macInstaller.js";

/** 退出时安装（含 macOS 同卷准备）最多占用退出屏障的时长；超时照常退出，安装包保留到下次。 */
const INSTALL_ON_QUIT_TIMEOUT_MS = 60_000;

/**
 * Windows NSIS 静默安装：`--updated` 保留安装位置与快捷方式，`--force-run` 安装后启动新版。
 * 需要提权等无法直接 spawn 的情况回退为打开交互安装器（ShellExecute 负责 UAC）。
 */
function launchWindowsInstaller(path: string, mode: GithubDesktopInstallMode): Promise<string> {
  const args = mode === "restart" ? ["/S", "--updated", "--force-run"] : ["/S", "--updated"];
  return new Promise<string>((resolve) => {
    let settled = false;
    const child = spawn(path, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve("");
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      void shell
        .openPath(path)
        .then(resolve, (error: unknown) =>
          resolve(error instanceof Error ? error.message : String(error)),
        );
    });
  });
}

/** 仅应用自己的顶层 Renderer 可请求更新，内嵌网页和子 frame 无权打开安装器。 */
function assertApplicationSender(event: IpcMainInvokeEvent): void {
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("更新操作仅允许应用窗口发起");
  }
}

export interface GithubDesktopUpdatesHandle {
  /** 设置页修改偏好后即时生效（Main syncImmediateAppSettings 调用）。 */
  setPreferences(patch: Partial<GithubDesktopUpdatePreferences>): void;
  /** 应用正常退出屏障内调用；有已校验安装包时交接静默安装，超时或失败照常退出。 */
  installOnQuit(): Promise<boolean>;
  dispose(): void;
}

export function installGithubDesktopUpdates(lifecycle: {
  confirmInstall(): boolean;
  quitForInstall(): Promise<void>;
  /** 启动前读取本机设置中的自动更新偏好；失败按默认（均开启）。 */
  readPreferences?: () => Promise<Partial<GithubDesktopUpdatePreferences>>;
}): GithubDesktopUpdatesHandle {
  // 成功交接后保留同一 flight，避免退出屏障期间的重复 IPC 再启动助手；取消与失败可重试。
  let installFlight: Promise<string> | undefined;
  // “重启以更新”已成功交接（Windows 安装器已启动）后，退出屏障不得再次启动安装器。
  let restartHandedOff = false;
  let networkFlight: Promise<Session> | undefined;
  const handOffWindowsInstaller = async (
    path: string,
    mode: GithubDesktopInstallMode,
  ): Promise<string> => {
    if (mode === "quit") return launchWindowsInstaller(path, mode);
    // “重启以更新”：沿用运行任务退出确认；取消则保留旧版，退出时仍可安装。
    if (!lifecycle.confirmInstall()) return "";
    const message = await launchWindowsInstaller(path, mode);
    if (message) return message;
    restartHandedOff = true;
    await lifecycle.quitForInstall();
    return "";
  };
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
    openInstaller: (path, version, signal, mode) => {
      if (mode === "quit" && (restartHandedOff || installFlight)) return Promise.resolve("");
      if (process.platform !== "darwin") return handOffWindowsInstaller(path, mode);
      if (installFlight) return installFlight;
      installFlight = installMacUpdate({
        appPath: dirname(dirname(dirname(process.execPath))),
        version,
        installerPath: path,
        logPath: join(app.getPath("userData"), "github-updates", "install.log"),
        signal,
        ...(mode === "quit"
          ? {
              // 应用已在退出屏障内：无需再次确认或触发退出，替换后不启动新版。
              confirmInstall: () => true,
              quitForInstall: async () => {},
              relaunch: false,
            }
          : {
              confirmInstall: lifecycle.confirmInstall,
              quitForInstall: lifecycle.quitForInstall,
              relaunch: true,
            }),
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
  // 先读本机偏好再启动，避免关闭“自动检查更新”的用户在启动瞬间仍发起请求。
  void (lifecycle.readPreferences?.() ?? Promise.resolve({}))
    .catch(() => ({}))
    .then((preferences) => {
      updater.setPreferences(preferences);
      updater.start();
    });
  return {
    setPreferences: (patch) => updater.setPreferences(patch),
    installOnQuit: () =>
      Promise.race([
        updater.installOnQuit(),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), INSTALL_ON_QUIT_TIMEOUT_MS).unref();
        }),
      ]),
    dispose: () => {
      updater.dispose();
      unsubscribe();
      powerMonitor.removeListener("resume", resume);
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
    },
  };
}
