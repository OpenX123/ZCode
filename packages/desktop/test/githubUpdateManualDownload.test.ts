import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGithubDesktopUpdater,
  type GithubDesktopUpdateOptions,
} from "../src/main/github-update/index.js";

// 两目标发布矩阵下，mac-x64 / win-arm64 曾因清单缺少本机安装器报错（“更新清单没有当前系统和架构的安装器”）；
// 现在改为提示从 Release 页面手动下载，且绝不请求其他架构的安装器。
const sha256 = "a".repeat(64);
function twoTargetManifest(version = "1.0.1") {
  return {
    schemaVersion: 1,
    version,
    releaseUrl: `https://github.com/OpenX123/ZCode/releases/tag/v${version}`,
    assets: [
      ["darwin", "arm64", "mac", "dmg"],
      ["win32", "x64", "win", "exe"],
    ].map(([platform, arch, os, ext]) => {
      const fileName = `YCode-${version}-${os}-${arch}.${ext}`;
      return {
        platform,
        arch,
        fileName,
        url: `https://github.com/OpenX123/ZCode/releases/download/v${version}/${fileName}`,
        size: 1,
        sha256,
      };
    }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(
  overrides: Partial<GithubDesktopUpdateOptions>,
  release = twoTargetManifest(),
) {
  const directory = await mkdtemp(join(tmpdir(), "ycode-github-update-manual-"));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(release));
  const openInstaller = vi.fn(async () => "");
  const updater = createGithubDesktopUpdater({
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    isPackaged: true,
    cacheDir: directory,
    fetch,
    openInstaller,
    preferences: { autoDownload: false },
    ...overrides,
  });
  cleanups.push(async () => {
    updater.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { updater, fetch, openInstaller, release };
}

describe("发布矩阵外平台的 GitHub 更新", () => {
  it.each([
    ["darwin", "x64"],
    ["win32", "arm64"],
  ])("%s-%s 提示从 Release 页面手动下载，下载/安装命令不改变状态", async (platform, arch) => {
    const { updater, fetch, openInstaller, release } = await fixture({ platform, arch });
    const manual = { kind: "manual-download", version: "1.0.1", releaseUrl: release.releaseUrl };
    await expect(updater.checkForUpdates()).resolves.toEqual(manual);
    expect(updater.getState()).toMatchObject({
      kind: "update-available",
      version: "1.0.1",
      manualDownload: true,
      releaseUrl: release.releaseUrl,
    });
    await expect(updater.downloadUpdate()).resolves.toEqual(manual);
    await expect(updater.installUpdate()).resolves.toEqual(manual);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openInstaller).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ kind: "update-available", manualDownload: true });
  });

  it("自动下载开启时也不后台下载其他架构安装器，退出时不安装", async () => {
    const { updater, fetch, openInstaller } = await fixture({
      platform: "darwin",
      arch: "x64",
      preferences: { autoDownload: true },
    });
    await updater.checkForUpdates(false);
    await expect(updater.installOnQuit()).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openInstaller).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ kind: "update-available", manualDownload: true });
  });

  it("相同版本仍返回已是最新，不留下 releaseUrl", async () => {
    const { updater } = await fixture({ arch: "x64" }, twoTargetManifest("1.0.0"));
    await expect(updater.checkForUpdates()).resolves.toEqual({
      kind: "up-to-date",
      currentVersion: "1.0.0",
    });
    expect(updater.getState()).toMatchObject({ kind: "idle" });
    expect(updater.getState()).not.toHaveProperty("releaseUrl");
  });

  it("发布矩阵内的平台照常提供自动更新", async () => {
    const { updater } = await fixture({ platform: "win32", arch: "x64" });
    await expect(updater.checkForUpdates()).resolves.toEqual({
      kind: "available",
      version: "1.0.1",
    });
    expect(updater.getState()).not.toHaveProperty("manualDownload");
  });
});
