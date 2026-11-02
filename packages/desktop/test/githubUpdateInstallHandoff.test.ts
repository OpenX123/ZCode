import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installMac: vi.fn(),
  create: vi.fn(),
  openPath: vi.fn(async () => ""),
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.3", isPackaged: true, getPath: () => "/tmp/ycode-update-test" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: vi.fn() },
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
function fixture() {
  mocks.create.mockReturnValue({
    getState: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    subscribe: () => () => {},
    start: vi.fn(),
    dispose: vi.fn(),
  });
  const lifecycle = { confirmInstall: vi.fn(() => true), quitForInstall: vi.fn(async () => {}) };
  disposers.push(installGithubDesktopUpdates(lifecycle));
  const options = mocks.create.mock.calls.at(-1)![0] as GithubDesktopUpdateOptions;
  return {
    lifecycle,
    open: () => options.openInstaller("/tmp/update.dmg", "1.0.4", new AbortController().signal),
  };
}

describe("GitHub 更新安装交接", () => {
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
  it("Windows 继续打开 EXE，不进入 macOS 安装器", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await fixture().open();
    expect(mocks.openPath).toHaveBeenCalledWith("/tmp/update.dmg");
    expect(mocks.installMac).not.toHaveBeenCalled();
  });
});
