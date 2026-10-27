import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubDesktopUpdater } from "./updater.js";
import type { GithubDesktopUpdateOptions } from "./contract.js";
import { GITHUB_UPDATE_MANIFEST_URL, MAX_INSTALLER_BYTES, UPDATE_INTERVAL_MS } from "./manifest.js";

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
  const openInstaller = vi.fn(async (_path: string) => "");
  const updater = createGithubDesktopUpdater({
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    isPackaged: true,
    cacheDir: directory,
    fetch,
    openInstaller,
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

describe("GitHub 桌面更新合同", () => {
  it.each([
    { isPackaged: false },
    { platform: "linux" },
    { arch: "ia32" },
    { currentVersion: "3.16.2" },
  ])("不支持的环境不请求网络：%j", async (overrides) => {
    const { updater, fetch } = await fixture(overrides);
    updater.start();
    expect(updater.getState()).toMatchObject({ kind: "idle", enabled: false });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    expect(fetch).not.toHaveBeenCalled();
    if (overrides.currentVersion) {
      await expect(updater.checkForUpdates()).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining("手工安装"),
      });
    }
  });

  it("并发检查合并，只请求清单，不自动下载安装器", async () => {
    const { updater, fetch } = await fixture();
    const first = updater.checkForUpdates();
    const second = updater.checkForUpdates();
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ kind: "available", version: "1.0.1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updater.getState()).toMatchObject({
      kind: "update-available",
      version: "1.0.1",
      currentVersion: "1.0.0",
    });
  });

  it.each(["1.0.0", "0.9.9"])("相同或旧版本 %s 不提供降级", async (version) => {
    const { updater } = await fixture({}, manifest(version));
    await expect(updater.checkForUpdates()).resolves.toEqual({
      kind: "up-to-date",
      currentVersion: "1.0.0",
    });
    expect(updater.getState()).toMatchObject({ kind: "idle" });
  });

  it("三段式版本使用数值比较", async () => {
    const { updater } = await fixture({ currentVersion: "1.0.2" }, manifest("1.0.10"));
    await expect(updater.checkForUpdates()).resolves.toMatchObject({
      kind: "available",
      version: "1.0.10",
    });
  });

  it.each([
    "other-repository",
    "other-tag",
    "path-traversal",
    "credentials",
    "query",
    "duplicate-target",
    "huge-installer",
    "wrong-extension",
    "malformed-version",
    "malformed-sha",
    "wrong-release",
  ])("拒绝不可信或畸形清单：%s", async (invalid) => {
    const release = manifest();
    const asset = release.assets[0]!;
    if (invalid === "other-repository") asset.url = asset.url.replace("OpenX123", "attacker");
    if (invalid === "other-tag") asset.url = asset.url.replace("v1.0.1", "v9.0.0");
    if (invalid === "path-traversal") asset.fileName = "../installer.dmg";
    if (invalid === "credentials") asset.url = asset.url.replace("https://", "https://user@");
    if (invalid === "query") asset.url += "?redirect=other";
    if (invalid === "duplicate-target") release.assets[1] = { ...asset };
    if (invalid === "huge-installer") asset.size = MAX_INSTALLER_BYTES + 1;
    if (invalid === "wrong-extension") asset.fileName = "installer.exe";
    if (invalid === "malformed-version") release.version = "latest";
    if (invalid === "malformed-sha") asset.sha256 = "invalid";
    if (invalid === "wrong-release")
      release.releaseUrl = release.releaseUrl.replace("github.com", "github.com.attacker.test");
    const { updater, openInstaller } = await fixture({}, release);
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ kind: "error" });
    expect(openInstaller).not.toHaveBeenCalled();
  });

  it("没有Content-Length的超大清单仍按实际字节拒绝", async () => {
    const { updater } = await fixture({
      fetch: vi.fn(async () => new Response(" ".repeat(64 * 1024 + 1))),
    });
    await expect(updater.checkForUpdates()).resolves.toMatchObject({
      kind: "error",
      message: "更新清单超过大小限制",
    });
  });

  it.each(["darwin", "win32"])(
    "%s 用户点击只下载本机架构，合并点击并打开一次",
    async (platform) => {
      const { updater, fetch, openInstaller } = await fixture({ platform, arch: "x64" });
      await updater.checkForUpdates();
      const first = updater.downloadUpdate();
      const second = updater.downloadUpdate();
      expect(first).toBe(second);
      await expect(first).resolves.toEqual({ kind: "ready", version: "1.0.1" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[1]![0])).toContain(
        `${platform === "darwin" ? "mac" : "win"}-x64.${platform === "darwin" ? "dmg" : "exe"}`,
      );
      expect(openInstaller).toHaveBeenCalledTimes(1);
      expect(await readFile(openInstaller.mock.calls[0]![0]!, "utf8")).toBe(body);
      expect(updater.getState()).toMatchObject({ kind: "update-downloaded", version: "1.0.1" });
    },
  );

  it("已下载后仍检查新版，同一清单保留已下载状态，新版替换候选", async () => {
    const { updater, fetch } = await fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    fetch.mockImplementation(async () => Response.json(manifest()));
    await expect(updater.checkForUpdates()).resolves.toEqual({ kind: "ready", version: "1.0.1" });
    expect(updater.getState().kind).toBe("update-downloaded");
    fetch.mockImplementation(async () => Response.json(manifest("1.0.2")));
    await expect(updater.checkForUpdates()).resolves.toEqual({
      kind: "available",
      version: "1.0.2",
    });
    expect(updater.getState()).toMatchObject({ kind: "update-available", version: "1.0.2" });
  });

  it("已下载归档离线复用，再打开前损坏必须拒绝且可重新下载", async () => {
    const { updater, fetch, openInstaller } = await fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    fetch.mockRejectedValue(new Error("offline"));
    await expect(updater.installUpdate()).resolves.toMatchObject({ kind: "ready" });
    expect(openInstaller).toHaveBeenCalledTimes(2);
    const path = openInstaller.mock.calls[0]![0]!;
    await writeFile(path, "corrupt");
    await expect(updater.installUpdate()).resolves.toMatchObject({ kind: "error" });
    expect(openInstaller).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => new Response(body));
    await expect(updater.downloadUpdate()).resolves.toMatchObject({ kind: "ready" });
    expect(openInstaller).toHaveBeenCalledTimes(3);
  });

  it.each(["wrong-sha", "short", "oversize", "wrong-header"])(
    "下载 %s 失败不打开，清理临时文件后可重试",
    async (invalid) => {
      const { updater, fetch, openInstaller, directory } = await fixture();
      await updater.checkForUpdates();
      fetch.mockImplementation(
        async () =>
          new Response(
            invalid === "wrong-sha"
              ? "x".repeat(body.length)
              : invalid === "short"
                ? "x"
                : body + "oversize",
            invalid === "wrong-header"
              ? { headers: { "content-length": String(body.length + 1) } }
              : {},
          ),
      );
      await expect(updater.downloadUpdate()).resolves.toMatchObject({ kind: "error" });
      expect(openInstaller).not.toHaveBeenCalled();
      expect(
        (await readdir(directory, { recursive: true })).filter((entry) => entry.endsWith(".tmp")),
      ).toEqual([]);
      fetch.mockImplementation(async () => new Response(body));
      await expect(updater.downloadUpdate()).resolves.toMatchObject({ kind: "ready" });
      expect(openInstaller).toHaveBeenCalledTimes(1);
    },
  );

  it("启动检查和唤醒共享六小时节流，手动检查绕过节流", async () => {
    let now = 0;
    const { updater, fetch } = await fixture({ now: () => now });
    updater.start();
    await updater.checkForUpdates(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = UPDATE_INTERVAL_MS - 1;
    await updater.checkForUpdates(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await updater.checkForUpdates(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    now += UPDATE_INTERVAL_MS;
    await updater.checkForUpdates(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("六小时间隔定时检查，重复start不会重复定时器", async () => {
    const { updater, fetch } = await fixture();
    vi.useFakeTimers();
    updater.start();
    updater.start();
    await updater.checkForUpdates(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    updater.dispose();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("下载期间检查不覆盖进度，dispose取消网络且迟到响应不打开安装器", async () => {
    const { updater, fetch, openInstaller } = await fixture();
    await updater.checkForUpdates();
    let finish!: (response: Response) => void;
    let downloadSignal: AbortSignal | undefined;
    fetch.mockImplementation(async (_url, init) => {
      downloadSignal = init?.signal ?? undefined;
      return await new Promise((resolve) => {
        finish = resolve;
      });
    });
    const downloading = updater.downloadUpdate();
    await vi.waitFor(() => expect(downloadSignal).toBeDefined());
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ kind: "already-downloading" });
    expect(updater.getState().kind).toBe("download-progress");
    updater.dispose();
    expect(downloadSignal?.aborted).toBe(true);
    finish(new Response(body));
    await expect(downloading).resolves.toMatchObject({ kind: "error" });
    expect(openInstaller).not.toHaveBeenCalled();
  });
});
