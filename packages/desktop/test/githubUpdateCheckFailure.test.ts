import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubDesktopUpdater } from "../src/main/github-update/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(
  overrides: { fetch?: typeof globalThis.fetch; platform?: string; arch?: string } = {},
) {
  const cacheDir = await mkdtemp(join(tmpdir(), "ycode-check-failure-"));
  const bytes = "installer";
  const version = "1.0.1";
  const base = "https://github.com/OpenX123/ZCode/releases";
  const manifest = {
    schemaVersion: 1,
    version,
    releaseUrl: `${base}/tag/v${version}`,
    assets: ["darwin", "win32"].flatMap((platform) =>
      ["arm64", "x64"].map((arch) => {
        const fileName = `YCode-${version}-${platform === "darwin" ? "mac" : "win"}-${arch}.${platform === "darwin" ? "dmg" : "exe"}`;
        return {
          platform,
          arch,
          fileName,
          url: `${base}/download/v${version}/${fileName}`,
          size: Buffer.byteLength(bytes),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
    ),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith("ycode-update.json") ? Response.json(manifest) : new Response(bytes),
  );
  const openInstaller = vi.fn(async () => "");
  const updater = createGithubDesktopUpdater({
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    isPackaged: true,
    cacheDir,
    fetch,
    openInstaller,
    preferences: { autoDownload: false },
    ...overrides,
  });
  cleanups.push(async () => {
    updater.dispose();
    await rm(cacheDir, { recursive: true, force: true });
  });
  return { updater, fetch, openInstaller, manifest };
}

describe("更新清单失联回归", () => {
  it.each([false, true])("清单404仅返回错误，不创建侧栏失败状态，manual=%s", async (manual) => {
    const { updater } = await fixture({
      fetch: vi.fn(async () => new Response(null, { status: 404 })),
    });
    await expect(updater.checkForUpdates(manual)).resolves.toMatchObject({
      kind: "error",
      message: "更新检查失败：HTTP 404",
    });
    expect(updater.getState()).toMatchObject({ kind: "idle", enabled: true });
  });

  it("后续检查失败仍保留已发现版本，允许用户继续下载", async () => {
    const { updater, fetch, openInstaller } = await fixture();
    await updater.checkForUpdates();
    const previous = updater.getState();
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ kind: "error" });
    expect(updater.getState()).toEqual(previous);
    await expect(updater.downloadUpdate()).resolves.toMatchObject({
      kind: "ready",
      version: "1.0.1",
    });
    // 1.5.0：下载只到“重启以更新”，不打开安装器。
    expect(openInstaller).not.toHaveBeenCalled();
  });
});

describe("发布目标收敛", () => {
  it.each([
    { platform: "darwin", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ])("双目标清单仅下载本机架构：%j", async (target) => {
    const { updater, fetch, openInstaller, manifest: release } = await fixture(target);
    release.assets = release.assets.filter(
      (asset) =>
        (asset.platform === "darwin" && asset.arch === "arm64") ||
        (asset.platform === "win32" && asset.arch === "x64"),
    );
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ kind: "available" });
    await updater.downloadUpdate();
    const selected = release.assets.find((asset) => asset.platform === target.platform)!;
    expect(fetch).toHaveBeenLastCalledWith(selected.url, expect.anything());
    expect(openInstaller).not.toHaveBeenCalled();
    expect(updater.getState().kind).toBe("update-downloaded");
  });

  it.each([1, 3])("拒绝不完整的 %s 目标清单", async (count) => {
    const { updater, manifest: release } = await fixture();
    release.assets = release.assets.slice(0, count);
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ kind: "error" });
  });

  it("拒绝缺少 Windows x64 的双目标清单", async () => {
    const { updater, manifest: release } = await fixture();
    release.assets = release.assets.slice(0, 2);
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ kind: "error" });
  });
});
