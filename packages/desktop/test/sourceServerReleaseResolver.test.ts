import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_VERSION } from "@zcode/shared";
import { resolveSourceServerReleaseAsset } from "../src/host/sourceServerReleaseResolver.js";

const target = { kind: "ssh", host: "example.com", username: "alice" } as const;
const probe = { platform: "linux", arch: "x64", installed: false } as const;
const fileName = "zcode-server-linux-x64.tar.gz";

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function descriptor(contents: string) {
  return {
    schemaVersion: 1,
    version: ZCODE_VERSION,
    archives: [
      {
        target: "linux-x64",
        version: ZCODE_VERSION,
        fileName,
        sha256: sha256(contents),
        sizeBytes: Buffer.byteLength(contents),
        urls: [fileName],
      },
    ],
  };
}

const temporaryRoots: string[] = [];
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function bundledRelease(contents: string) {
  const root = await temporaryRoot("ycode-bundled-descriptor-");
  const releaseDir = join(root, "releases", ZCODE_VERSION);
  await mkdir(releaseDir, { recursive: true });
  const releaseDescriptor = descriptor(contents);
  releaseDescriptor.archives[0]!.urls = [`https://release.example.test/build-8-1/${fileName}`];
  const descriptorPath = join(releaseDir, "source-server-release.json");
  await writeFile(descriptorPath, JSON.stringify(releaseDescriptor));
  const cacheRoot = join(root, "cache");
  const cacheDir = join(cacheRoot, "source-server", ZCODE_VERSION, "linux-x64", sha256(contents));
  return {
    root,
    releaseDir,
    descriptorPath,
    releaseDescriptor,
    cacheDir,
    cachePath: join(cacheDir, fileName),
    assets: { mockCdnDir: root, remoteCacheDir: cacheRoot },
  };
}

describe("Source Server release resolver", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it.each(["local-download-upload", "remote-download"] as const)(
    "无显式镜像时 %s 不读取旧缓存地址或旧归档",
    async (assetInstallMode) => {
      const root = await temporaryRoot("zcode-retired-release-cache-");
      const cacheDir = join(root, "source-server", ZCODE_VERSION);
      const contents = "retired-source-server";
      const cachedDescriptor = descriptor(contents);
      cachedDescriptor.archives[0]!.urls = ["https://retired.example.test/old-server.tar.gz"];
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        join(cacheDir, "source-server-release.json"),
        JSON.stringify(cachedDescriptor),
      );
      await writeFile(join(cacheDir, fileName), contents);
      const fetch = vi.fn(async () => new Response(contents));
      try {
        await expect(
          resolveSourceServerReleaseAsset(
            probe,
            { remoteCacheDir: root },
            { ...target, assetInstallMode },
            { fetch },
          ),
        ).rejects.toThrow("Source Server 本地产物缺失");
        expect(fetch).not.toHaveBeenCalled();
        expect(await readFile(join(cacheDir, fileName), "utf8")).toBe(contents);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("显式镜像失败时不回退旧 descriptor 中的远程地址", async () => {
    const root = await temporaryRoot("zcode-release-mirror-failed-");
    const cacheDir = join(root, "source-server", ZCODE_VERSION);
    const cachedDescriptor = descriptor("retired");
    cachedDescriptor.archives[0]!.urls = ["https://retired.example.test/old-server.tar.gz"];
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "source-server-release.json"), JSON.stringify(cachedDescriptor));
    const fetch = vi.fn(
      async (_input: string | URL | Request) => new Response(null, { status: 503 }),
    );
    try {
      await expect(
        resolveSourceServerReleaseAsset(
          probe,
          { remoteCdnBaseUrl: "https://mirror.example.test/releases", remoteCacheDir: root },
          target,
          { fetch },
        ),
      ).rejects.toThrow("Unable to resolve Source Server release descriptor");
      expect(
        fetch.mock.calls.every(([url]) => String(url).startsWith("https://mirror.example.test/")),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("previews descriptor metadata without downloading the archive", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("source-server-release.json"))
        return new Response(JSON.stringify(descriptor("preview-package")));
      throw new Error("preview must not fetch archives");
    });
    const release = await resolveSourceServerReleaseAsset(
      probe,
      { remoteCdnBaseUrl: "https://release.test" },
      target,
      { fetch },
      { metadataOnly: true },
    );
    expect(release).toMatchObject({ version: ZCODE_VERSION, sizeBytes: 15 });
    expect(release.localArchivePath).toBeUndefined();
    expect(
      fetch.mock.calls.every(([url]) => String(url).endsWith("source-server-release.json")),
    ).toBe(true);
  });
  it.each(["local-download-upload", "remote-download"] as const)(
    "%s 无显式镜像时校验并使用随包源码归档",
    async (assetInstallMode) => {
      const root = await temporaryRoot("zcode-source-release-local-");
      const releaseDir = join(root, "releases", ZCODE_VERSION);
      const contents = "local-source-server";
      await mkdir(releaseDir, { recursive: true });
      await writeFile(join(releaseDir, fileName), contents);
      await writeFile(
        join(releaseDir, "source-server-release.json"),
        JSON.stringify(descriptor(contents)),
      );

      const release = await resolveSourceServerReleaseAsset(
        probe,
        { mockCdnDir: root },
        { ...target, assetInstallMode },
      );

      expect(release).toMatchObject({
        localArchivePath: join(releaseDir, fileName),
        target: "linux-x64",
        version: ZCODE_VERSION,
        sha256: sha256(contents),
        sizeBytes: Buffer.byteLength(contents),
      });
    },
  );

  it("uses the staged local archive for development even when SSH prefers remote download", async () => {
    const root = await temporaryRoot("zcode-source-release-dev-local-");
    const releaseDir = join(root, "releases", ZCODE_VERSION);
    const contents = "development-source-server";
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, fileName), contents);
    await writeFile(
      join(releaseDir, "source-server-release.json"),
      JSON.stringify(descriptor(contents)),
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("development resolution must not access CDN");
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        mockCdnDir: root,
        sourceServerArtifactPolicy: "development-content-addressed",
      },
      { ...target, assetInstallMode: "remote-download" },
    );

    expect(release.localArchivePath).toBe(join(releaseDir, fileName));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without a staged local development descriptor", async () => {
    const fetchMock = vi.fn(async () => new Response("production-release", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        {
          sourceServerArtifactPolicy: "development-content-addressed",
          remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
        },
        target,
      ),
    ).rejects.toThrow("run pnpm bootstrap:with-remote");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves descriptor URLs without downloading the archive for remote-download", async () => {
    const root = await temporaryRoot("zcode-source-release-remote-");
    const contents = "remote-source-server";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.endsWith("/source-server-release.json")) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(descriptor(contents)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
        remoteCacheDir: root,
      },
      { ...target, assetInstallMode: "remote-download" },
    );

    expect(release).toEqual({
      target: "linux-x64",
      version: ZCODE_VERSION,
      sha256: sha256(contents),
      sizeBytes: Buffer.byteLength(contents),
      urls: [`https://cdn.example.test/releases/${ZCODE_VERSION}/${fileName}`],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads and verifies the descriptor archive into the Desktop cache", async () => {
    const root = await temporaryRoot("zcode-source-release-cache-");
    const contents = "cached-source-server";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/source-server-release.json")) {
        return new Response(JSON.stringify(descriptor(contents)), { status: 200 });
      }
      if (url.endsWith(`/${fileName}`)) return new Response(contents, { status: 200 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
        remoteCacheDir: root,
      },
      target,
    );

    expect(release.localArchivePath).toBe(
      join(root, "source-server", ZCODE_VERSION, "linux-x64", sha256(contents), fileName),
    );
    await expect(readFile(release.localArchivePath!, "utf8")).resolves.toBe(contents);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the injected remote asset network for descriptor and archive downloads", async () => {
    const root = await temporaryRoot("zcode-source-release-proxy-");
    const contents = "proxy-source-server";
    const remoteAssetFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/source-server-release.json")) {
        return new Response(JSON.stringify(descriptor(contents)), { status: 200 });
      }
      if (url.endsWith(`/${fileName}`)) return new Response(contents, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const directFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("remote asset direct fetch is forbidden"));
    vi.stubGlobal("fetch", directFetch);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
        remoteCacheDir: root,
      },
      target,
      { fetch: remoteAssetFetch },
    );

    expect(release.localArchivePath).toBe(
      join(root, "source-server", ZCODE_VERSION, "linux-x64", sha256(contents), fileName),
    );
    expect(remoteAssetFetch).toHaveBeenCalledTimes(2);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("does not fall back to direct fetch when the injected network fails", async () => {
    const root = await temporaryRoot("zcode-source-release-proxy-failure-");
    const directFetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(descriptor("direct-source-server"))),
    );
    vi.stubGlobal("fetch", directFetch);
    const remoteAssetFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("proxy unavailable"));

    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        {
          remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
          remoteCacheDir: root,
        },
        target,
        { fetch: remoteAssetFetch },
      ),
    ).rejects.toMatchObject({
      message: "Unable to resolve Source Server release descriptor",
      cause: expect.objectContaining({ message: "proxy unavailable" }),
    });
    expect(remoteAssetFetch).toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });
  it("随包清单无需联网即可预览或给远端下载提供固定 URL", async () => {
    const fixture = await bundledRelease("bundled-metadata");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));
    for (const options of [{ metadataOnly: true }, {}]) {
      const release = await resolveSourceServerReleaseAsset(
        probe,
        fixture.assets,
        { ...target, assetInstallMode: "remote-download" },
        { fetch },
        options,
      );
      expect(release.localArchivePath).toBeUndefined();
      expect(release.urls).toEqual(fixture.releaseDescriptor.archives[0]!.urls);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("仅下载探测目标，按清单校验后缓存，并在断网时复用", async () => {
    const contents = "selected-linux-x64";
    const fixture = await bundledRelease(contents);
    fixture.releaseDescriptor.archives.push({
      ...fixture.releaseDescriptor.archives[0]!,
      target: "darwin-arm64",
      fileName: "zcode-server-darwin-arm64.tar.gz",
      urls: ["https://release.example.test/build-8-1/zcode-server-darwin-arm64.tar.gz"],
    });
    await writeFile(fixture.descriptorPath, JSON.stringify(fixture.releaseDescriptor));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(contents));
    const first = await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    expect(first.localArchivePath).toBe(fixture.cachePath);
    expect(fetch).toHaveBeenCalledWith(
      fixture.releaseDescriptor.archives[0]!.urls[0],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fetch.mockRejectedValue(new Error("offline"));
    const second = await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    expect(second.localArchivePath).toBe(first.localArchivePath);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("离线预热的归档经过同一校验，损坏缓存会重新下载", async () => {
    const contents = "preloaded-archive";
    const fixture = await bundledRelease(contents);
    await mkdir(fixture.cacheDir, { recursive: true });
    await writeFile(fixture.cachePath, contents);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(contents));
    await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    await writeFile(fixture.cachePath, "corrupt");
    await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(fixture.cachePath, "utf8")).toBe(contents);
  });

  it("显式镜像优先下载同一 SHA 的归档，不覆盖随包版本清单", async () => {
    const contents = "mirrored-archive";
    const fixture = await bundledRelease(contents);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(contents));
    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        ...fixture.assets,
        remoteCdnBaseUrl: `https://mirror.example.test/releases/${ZCODE_VERSION}`,
      },
      target,
      { fetch },
    );
    expect(release.sha256).toBe(sha256(contents));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `https://mirror.example.test/releases/${ZCODE_VERSION}/${fileName}`,
      expect.any(Object),
    );
  });

  it("回收已退出进程的锁后可以重新下载", async () => {
    const contents = "orphaned-lock-archive";
    const fixture = await bundledRelease(contents);
    const lockDir = `${fixture.cachePath}.lock`;
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2147483647, token: "exited-owner" }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(contents));
    const release = await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    expect(release.localArchivePath).toBe(fixture.cachePath);
    expect(await readdir(fixture.cacheDir)).toEqual([fileName]);
  });

  it.each(["exited-reaper", "old-empty-marker"])(
    "遗留回收标记 %s 立即给出清理提示，保留锁内容且不触发下载",
    async (markerKind) => {
      const fixture = await bundledRelease("interrupted-reaper-archive");
      const lockDir = `${fixture.cachePath}.lock`;
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid: 2147483647, token: "exited-owner" }),
      );
      const reaperPath = join(lockDir, ".reaping");
      await writeFile(
        reaperPath,
        markerKind === "exited-reaper"
          ? JSON.stringify({ pid: 2147483647, token: "exited-reaper" })
          : "",
      );
      if (markerKind === "old-empty-marker") {
        const expired = new Date(Date.now() - 120_000);
        await utimes(reaperPath, expired, expired);
      }
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch }),
      ).rejects.toThrow(`远程资源缓存锁回收中断；请删除锁目录后重试：${lockDir}`);
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(lockDir)).toEqual([".reaping", "owner.json"]);
    },
  );

  it.each([false, true])(
    "同根目录、目标与 SHA 的并发请求只下载一次，损坏缓存=%s",
    async (corruptCache) => {
      const contents = "concurrent-archive";
      const fixture = await bundledRelease(contents);
      if (corruptCache) {
        await mkdir(fixture.cacheDir, { recursive: true });
        await writeFile(fixture.cachePath, "x".repeat(Buffer.byteLength(contents)));
      }
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(contents));
      const releases = await Promise.all(
        Array.from({ length: 6 }, () =>
          resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch }),
        ),
      );
      expect(releases.every((release) => release.localArchivePath === fixture.cachePath)).toBe(
        true,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await readdir(fixture.cacheDir)).toEqual([fileName]);
    },
  );

  it("同版本不同构建的 SHA 缓存不会互相覆盖", async () => {
    const fixture = await bundledRelease("first-build");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("first-build"));
    const first = await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    const changed = descriptor("second-build");
    changed.archives[0]!.urls = [`https://release.example.test/build-8-2/${fileName}`];
    await writeFile(fixture.descriptorPath, JSON.stringify(changed));
    fetch.mockImplementation(async () => new Response("second-build"));
    const second = await resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch });
    expect(second.localArchivePath).not.toBe(first.localArchivePath);
    expect(await readFile(first.localArchivePath!, "utf8")).toBe("first-build");
    expect(await readFile(second.localArchivePath!, "utf8")).toBe("second-build");
  });

  it("SHA 错误不会发布缓存，清理临时文件后可重试", async () => {
    const contents = "verified-archive";
    const fixture = await bundledRelease(contents);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("wrong"));
    await expect(
      resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch }),
    ).rejects.toThrow("Unable to download Source Server release");
    expect(await readdir(fixture.cacheDir)).toEqual([]);
    fetch.mockImplementation(async () => new Response(contents));
    await expect(
      resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch }),
    ).resolves.toMatchObject({ localArchivePath: fixture.cachePath });
  });

  it("取消下载会释放锁并清除临时文件，后续连接可重新获取", async () => {
    const contents = "cancelled-archive";
    const fixture = await bundledRelease(contents);
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort(new Error("connection cancelled"));
      return new Response(contents);
    });
    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        fixture.assets,
        target,
        { fetch },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("connection cancelled");
    expect(await readdir(fixture.cacheDir)).toEqual([]);
    fetch.mockImplementation(async () => new Response(contents));
    await expect(
      resolveSourceServerReleaseAsset(probe, fixture.assets, target, { fetch }),
    ).resolves.toMatchObject({ localArchivePath: fixture.cachePath });
  });

  it("开发态只有 descriptor 时必须报错，不能使用正式 Release 下载", async () => {
    const fixture = await bundledRelease("dev-archive");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("dev-archive"));
    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        { ...fixture.assets, sourceServerArtifactPolicy: "development-content-addressed" },
        target,
        { fetch },
      ),
    ).rejects.toThrow("local archive failed descriptor verification");
    expect(fetch).not.toHaveBeenCalled();
  });
});
