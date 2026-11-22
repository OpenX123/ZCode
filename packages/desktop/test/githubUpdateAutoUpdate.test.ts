import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubDesktopUpdater } from "../src/main/github-update/updater.js";
import type { GithubDesktopUpdateOptions } from "../src/main/github-update/contract.js";
import {
  GITHUB_UPDATE_MANIFEST_URL,
  UPDATE_INTERVAL_MS,
} from "../src/main/github-update/manifest.js";

const body = "verified installer bytes";
const hash = createHash("sha256").update(body).digest("hex");
function manifest(version = "1.0.1") {
  return {
    schemaVersion: 1,
    version,
    releaseUrl: `https://github.com/OpenX123/ZCode/releases/tag/v${version}`,
    assets: ["darwin", "win32"].flatMap((platform) =>
      ["arm64", "x64"].map((arch) => {
        const fileName = `YCode-${version}-${platform === "darwin" ? "mac" : "win"}-${arch}.${platform === "darwin" ? "dmg" : "exe"}`;
        return {
          platform,
          arch,
          fileName,
          url: `https://github.com/OpenX123/ZCode/releases/download/v${version}/${fileName}`,
          size: Buffer.byteLength(body),
          sha256: hash,
        };
      }),
    ),
  };
}
const fixtures: Array<{ dispose(): void; directory: string }> = [];
async function fixture(overrides: Partial<GithubDesktopUpdateOptions> = {}, release = manifest()) {
  const directory = await mkdtemp(join(tmpdir(), "ycode-github-update-"));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input) === GITHUB_UPDATE_MANIFEST_URL ? Response.json(release) : new Response(body),
  );
  const openInstaller = vi.fn(
    async (_path: string, _version: string, _signal: AbortSignal, _mode: string) => "",
  );
  const updater = createGithubDesktopUpdater({
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    isPackaged: true,
    cacheDir: directory,
    fetch,
    openInstaller,
    // 既有合同默认关闭自动下载，单独用例覆盖 1.5.0 的后台下载。
    preferences: { autoDownload: false },
    ...overrides,
  });
  fixtures.push({ dispose: updater.dispose, directory });
  return { updater, fetch, openInstaller, directory, release };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    fixtures.splice(0).map(async (item) => {
      item.dispose();
      await rm(item.directory, { recursive: true, force: true });
    }),
  );
});

describe("GitHub 桌面自动更新（1.5.0：自动检查、后台下载、退出时安装）", () => {
  it("自动下载开启：检查发现新版后后台下载校验，进入重启以更新且不打开安装器", async () => {
    const { updater, fetch, openInstaller } = await fixture({
      preferences: { autoDownload: true },
    });
    await expect(updater.checkForUpdates(false)).resolves.toEqual({
      kind: "available",
      version: "1.0.1",
    });
    await vi.waitFor(() => expect(updater.getState().kind).toBe("update-downloaded"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(openInstaller).not.toHaveBeenCalled();
    await expect(updater.checkForUpdates(true)).resolves.toEqual({
      kind: "ready",
      version: "1.0.1",
    });
  });

  it("后台下载失败恢复发现新版，不发布持久错误；用户点击下载失败仍为错误", async () => {
    const { updater, fetch } = await fixture({ preferences: { autoDownload: true } });
    fetch.mockImplementation(async (input) =>
      String(input) === GITHUB_UPDATE_MANIFEST_URL ? Response.json(manifest()) : new Response("x"),
    );
    await updater.checkForUpdates(false);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(updater.getState()).toMatchObject({ kind: "update-available", version: "1.0.1" }),
    );
    await expect(updater.downloadUpdate()).resolves.toMatchObject({ kind: "error" });
    expect(updater.getState()).toMatchObject({ kind: "error", version: "1.0.1" });
  });

  it("关闭自动检查：start 与自动检查不请求网络，手动检查仍请求，重新开启后恢复", async () => {
    let now = 0;
    const { updater, fetch } = await fixture({
      preferences: { autoCheck: false, autoDownload: false },
      now: () => now,
    });
    vi.useFakeTimers();
    updater.start();
    await updater.checkForUpdates(false);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetch).not.toHaveBeenCalled();
    await updater.checkForUpdates(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    updater.setPreferences({ autoCheck: true });
    now = UPDATE_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    updater.setPreferences({ autoCheck: false });
    now = UPDATE_INTERVAL_MS * 3;
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("运行中开启自动下载，已发现的新版立即后台下载", async () => {
    const { updater } = await fixture();
    updater.start();
    await updater.checkForUpdates(true);
    expect(updater.getState().kind).toBe("update-available");
    updater.setPreferences({ autoDownload: true });
    await vi.waitFor(() => expect(updater.getState().kind).toBe("update-downloaded"));
  });

  it("退出时安装：只有已校验安装包才以 quit 模式交接一次，损坏不交接", async () => {
    const { updater, openInstaller } = await fixture();
    await expect(updater.installOnQuit()).resolves.toBe(false);
    await updater.checkForUpdates();
    await expect(updater.installOnQuit()).resolves.toBe(false);
    await updater.downloadUpdate();
    await expect(updater.installOnQuit()).resolves.toBe(true);
    expect(openInstaller).toHaveBeenCalledTimes(1);
    expect(openInstaller.mock.calls[0]![3]).toBe("quit");
    await expect(updater.installOnQuit()).resolves.toBe(false);
    expect(openInstaller).toHaveBeenCalledTimes(1);

    const second = await fixture();
    await second.updater.checkForUpdates();
    await second.updater.downloadUpdate();
    const path = (await readdir(second.directory, { recursive: true }))
      .map((entry) => join(second.directory, entry))
      .find((entry) => entry.endsWith(".dmg"))!;
    await writeFile(path, "corrupt");
    await expect(second.updater.installOnQuit()).resolves.toBe(false);
    expect(second.openInstaller).not.toHaveBeenCalled();
  });

  it("交接失败的退出时安装不抛错且允许再次尝试", async () => {
    const { updater, openInstaller } = await fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    openInstaller.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(updater.installOnQuit()).resolves.toBe(false);
    await expect(updater.installOnQuit()).resolves.toBe(true);
  });
});
