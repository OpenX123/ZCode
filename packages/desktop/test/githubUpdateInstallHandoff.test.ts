import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installMac: vi.fn(),
  create: vi.fn(),
  openPath: vi.fn(async () => ""),
  setProxy: vi.fn(async () => {}),
  sessionFetch: vi.fn(async () => new Response("update")),
  fromPartition: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.3", isPackaged: true, getPath: () => "/tmp/ycode-update-test" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: vi.fn() },
  session: { fromPartition: mocks.fromPartition },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  shell: { openPath: mocks.openPath },
}));
vi.mock("../src/main/github-update/macInstaller.js", () => ({
  installMacUpdate: mocks.installMac,
}));
vi.mock("../src/main/github-update/updater.js", () => ({
  createGithubDesktopUpdater: mocks.create,
}));
import { installGithubDesktopUpdates } from "../src/main/github-update/electronAdapter.js";
import type { GithubDesktopUpdateOptions } from "../src/main/github-update/contract.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
/** 模拟 child_process.spawn：outcome=spawn 表示进程已启动，error 表示启动失败（如需提权）。 */
function stubSpawn(outcome: "spawn" | "error" = "spawn") {
  mocks.spawn.mockImplementation(() => {
    const listeners = new Map<string, () => void>();
    const child = {
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
        return child;
      },
      unref: vi.fn(),
    };
    queueMicrotask(() => listeners.get(outcome)?.());
    return child;
  });
}

function fixture(readPreferences?: () => Promise<Record<string, boolean>>) {
  mocks.fromPartition.mockReturnValue({ setProxy: mocks.setProxy, fetch: mocks.sessionFetch });
  const updater = {
    getState: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    installOnQuit: vi.fn(async () => true),
    setPreferences: vi.fn(),
    subscribe: () => () => {},
    start: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.create.mockReturnValue(updater);
  const lifecycle = { confirmInstall: vi.fn(() => true), quitForInstall: vi.fn(async () => {}) };
  const handle = installGithubDesktopUpdates({
    ...lifecycle,
    ...(readPreferences ? { readPreferences } : {}),
  });
  disposers.push(handle.dispose);
  const options = mocks.create.mock.calls.at(-1)![0] as GithubDesktopUpdateOptions;
  return {
    lifecycle,
    updater,
    handle,
    fetch: options.fetch,
    open: (mode: "restart" | "quit" = "restart", path = "/tmp/update.dmg") =>
      options.openInstaller(path, "1.0.4", new AbortController().signal, mode),
  };
}

describe("GitHub 更新安装交接", () => {
  it("清单与安装包复用独立的系统代理会话，不复用模型 API 网络", async () => {
    const { fetch } = fixture();
    const request = { signal: new AbortController().signal };
    await fetch(new URL("https://github.com/manifest"), request);
    await fetch("https://github.com/installer", request);
    expect(mocks.fromPartition).toHaveBeenCalledWith("ycode-github-updates");
    expect(mocks.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: "system" });
    expect(mocks.sessionFetch).toHaveBeenNthCalledWith(1, "https://github.com/manifest", request);
    expect(mocks.sessionFetch).toHaveBeenNthCalledWith(2, "https://github.com/installer", request);
  });
  it("系统代理初始化完成前不发请求，并发请求共用初始化", async () => {
    let ready!: () => void;
    mocks.setProxy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const { fetch } = fixture();
    const first = fetch("https://github.com/manifest");
    const second = fetch("https://github.com/manifest");
    expect(mocks.sessionFetch).not.toHaveBeenCalled();
    ready();
    await Promise.all([first, second]);
    expect(mocks.setProxy).toHaveBeenCalledTimes(1);
    expect(mocks.sessionFetch).toHaveBeenCalledTimes(2);
  });
  it("网络初始化失败后可重试", async () => {
    mocks.setProxy.mockRejectedValueOnce(new Error("proxy init failed"));
    const { fetch } = fixture();
    await expect(fetch("https://github.com/manifest")).rejects.toThrow("proxy init failed");
    await fetch("https://github.com/manifest");
    expect(mocks.setProxy).toHaveBeenCalledTimes(2);
    expect(mocks.sessionFetch).toHaveBeenCalledTimes(1);
  });
  it("macOS 的重复 IPC 共用安装助手；成功后直到退出也不重入", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    let finish!: (installed: boolean) => void;
    mocks.installMac.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { open, lifecycle } = fixture();
    const first = open();
    expect(open()).toBe(first);
    expect(mocks.installMac).toHaveBeenCalledTimes(1);
    expect(mocks.installMac).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "1.0.4",
        signal: expect.any(AbortSignal),
        relaunch: true,
        ...lifecycle,
      }),
    );
    finish(true);
    expect(await first).toBe("");
    expect(await open()).toBe("");
    expect(mocks.installMac).toHaveBeenCalledTimes(1);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
  it.each(["cancel", "failure"])("%s 后保留重试能力", async (mode) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    if (mode === "cancel") mocks.installMac.mockResolvedValueOnce(false);
    else mocks.installMac.mockRejectedValueOnce(new Error("staging failed"));
    mocks.installMac.mockResolvedValueOnce(true);
    const { open } = fixture();
    if (mode === "cancel") await expect(open()).resolves.toBe("");
    else await expect(open()).rejects.toThrow("staging failed");
    await expect(open()).resolves.toBe("");
    expect(mocks.installMac).toHaveBeenCalledTimes(2);
  });
  it("Windows 重启以更新：确认后静默运行安装器并启动新版，再经退出屏障退出", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    stubSpawn("spawn");
    const { open, lifecycle } = fixture();
    await expect(open("restart", "C:/cache/YCode.exe")).resolves.toBe("");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:/cache/YCode.exe",
      ["/S", "--updated", "--force-run"],
      expect.objectContaining({ detached: true }),
    );
    expect(lifecycle.quitForInstall).toHaveBeenCalledTimes(1);
    expect(mocks.installMac).not.toHaveBeenCalled();
    // 已交接后退出屏障不再启动第二个安装器
    await expect(open("quit", "C:/cache/YCode.exe")).resolves.toBe("");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("Windows 重启以更新被运行任务确认取消时不启动安装器，退出时仍可安装", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    stubSpawn("spawn");
    const { open, lifecycle } = fixture();
    lifecycle.confirmInstall.mockReturnValueOnce(false);
    await expect(open("restart", "C:/cache/YCode.exe")).resolves.toBe("");
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(open("quit", "C:/cache/YCode.exe")).resolves.toBe("");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:/cache/YCode.exe",
      ["/S", "--updated"],
      expect.objectContaining({ detached: true }),
    );
    expect(lifecycle.quitForInstall).not.toHaveBeenCalled();
  });
  it("Windows 静默安装器无法启动时回退打开交互安装器", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    stubSpawn("error");
    const { open } = fixture();
    await expect(open("quit", "C:/cache/YCode.exe")).resolves.toBe("");
    expect(mocks.openPath).toHaveBeenCalledWith("C:/cache/YCode.exe");
  });
  it("macOS 退出时安装：不再确认或触发退出，替换后不启动新版", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.installMac.mockResolvedValueOnce(true);
    const { open, lifecycle } = fixture();
    await expect(open("quit")).resolves.toBe("");
    const options = mocks.installMac.mock.calls[0]![0] as {
      relaunch: boolean;
      confirmInstall(): boolean;
      quitForInstall(): Promise<void>;
    };
    expect(options.relaunch).toBe(false);
    expect(options.confirmInstall()).toBe(true);
    await options.quitForInstall();
    expect(lifecycle.confirmInstall).not.toHaveBeenCalled();
    expect(lifecycle.quitForInstall).not.toHaveBeenCalled();
  });
  it("先读取本机偏好再启动自动检查；读取失败按默认启动", async () => {
    const { updater } = fixture(async () => ({ autoCheck: false, autoDownload: true }));
    expect(updater.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(updater.start).toHaveBeenCalledTimes(1));
    expect(updater.setPreferences).toHaveBeenCalledWith({ autoCheck: false, autoDownload: true });
    expect(updater.setPreferences.mock.invocationCallOrder[0]!).toBeLessThan(
      updater.start.mock.invocationCallOrder[0]!,
    );
    const failing = fixture(async () => {
      throw new Error("settings unavailable");
    });
    await vi.waitFor(() => expect(failing.updater.start).toHaveBeenCalledTimes(1));
    expect(failing.updater.setPreferences).toHaveBeenCalledWith({});
  });
  it("句柄转发偏好补丁与退出时安装", async () => {
    const { handle, updater } = fixture();
    handle.setPreferences({ autoDownload: false });
    expect(updater.setPreferences).toHaveBeenCalledWith({ autoDownload: false });
    await expect(handle.installOnQuit()).resolves.toBe(true);
    expect(updater.installOnQuit).toHaveBeenCalledTimes(1);
  });
});
