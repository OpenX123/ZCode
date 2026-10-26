import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ZCODE_VERSION } from "@zcode/shared";
import { importSourceServerRelease } from "../scripts/import-source-server-release.mjs";
import { resolveSourceServerReleaseAsset } from "../src/host/sourceServerReleaseResolver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(version = ZCODE_VERSION) {
  const root = await mkdtemp(join(tmpdir(), "ycode-offline-import-"));
  roots.push(root);
  const content = "verified-source-server-fixture";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const fileName = "zcode-server-linux-x64.tar.gz";
  const releaseDir = join(root, "bundled", "releases", ZCODE_VERSION);
  await mkdir(releaseDir, { recursive: true });
  const descriptorPath = join(releaseDir, "source-server-release.json");
  const archivePath = join(root, fileName);
  const cacheDir = join(root, "cache");
  await writeFile(
    descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      version,
      archives: [
        {
          target: "linux-x64",
          version,
          fileName,
          sha256,
          sizeBytes: Buffer.byteLength(content),
          urls: [`https://github.com/OpenX123/ZCode/releases/download/build-test/${fileName}`],
        },
      ],
    }),
  );
  await writeFile(archivePath, content);
  return { root, content, descriptorPath, archivePath, cacheDir };
}

it("导入后正式版 resolver 完全离线命中已校验缓存", async () => {
  const fixtureData = await fixture();
  const destination = await importSourceServerRelease(fixtureData);
  const fetch = vi.fn(() => {
    throw new Error("offline");
  });
  const asset = await resolveSourceServerReleaseAsset(
    { platform: "linux", arch: "x64", installed: false },
    { mockCdnDir: join(fixtureData.root, "bundled"), remoteCacheDir: fixtureData.cacheDir },
    { kind: "ssh", host: "example.test", username: "test" },
    { fetch },
  );
  expect(asset.localArchivePath).toBe(destination);
  expect(await readFile(destination, "utf8")).toBe(fixtureData.content);
  expect(fetch).not.toHaveBeenCalled();
});

it("损坏输入不覆盖有效缓存且清理临时文件", async () => {
  const fixtureData = await fixture();
  const destination = await importSourceServerRelease(fixtureData);
  await writeFile(fixtureData.archivePath, "damaged");
  await expect(importSourceServerRelease(fixtureData)).rejects.toThrow("SHA-256");
  expect(await readFile(destination, "utf8")).toBe(fixtureData.content);
  expect(await readdir(join(destination, ".."))).toEqual(["zcode-server-linux-x64.tar.gz"]);
});

it("拒绝使用版本路径逃逸缓存根目录", async () => {
  const fixtureData = await fixture("../../escape");
  await expect(importSourceServerRelease(fixtureData)).rejects.toThrow("路径分隔符");
  expect(await readdir(fixtureData.root)).not.toContain("cache");
});
