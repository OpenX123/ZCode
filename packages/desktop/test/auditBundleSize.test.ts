import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const mib = 1024 * 1024;
const script = resolve(import.meta.dirname, "../scripts/audit-bundle-size.mjs");
const roots: string[] = [];
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function fixture(extension = ".zip") {
  const root = mkdtempSync(join(tmpdir(), "zcode-size-audit-"));
  roots.push(root);
  const resources = join(root, "Resources", "remote-assets", "releases", "1.2.3");
  mkdirSync(resources, { recursive: true });
  const artifact = join(root, `app${extension}`);
  writeFileSync(artifact, "");
  const archives = targets.map((target) => {
    const fileName = `zcode-server-${target}.tar.gz`;
    const content = Buffer.from(`fixture ${target}`);
    writeFileSync(join(resources, fileName), content);
    return {
      target,
      version: "1.2.3",
      fileName,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      urls: [fileName],
    };
  });
  const descriptor = { schemaVersion: 1, version: "1.2.3", archives };
  const save = () =>
    writeFileSync(join(resources, "source-server-release.json"), JSON.stringify(descriptor));
  save();
  const audit = (withResources = true, lightweight = false) =>
    spawnSync(
      process.execPath,
      [
        script,
        "--artifact-path",
        artifact,
        ...(withResources ? ["--remote-assets-dir", resources, "--version", "1.2.3"] : []),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY: lightweight ? "1" : "0" },
      },
    );
  const makeLightweight = () => {
    for (const archive of archives) {
      rmSync(join(resources, archive.fileName));
      archive.urls = [
        `https://github.com/OpenX123/ZCode/releases/download/build-8-1/${archive.fileName}`,
      ];
    }
    save();
  };
  return { root, artifact, resources, descriptor, save, audit, makeLightweight };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("安装包基础与离线资源预算", () => {
  it("只有校验过的四平台资源实际字节能增加500MiB基础额度", () => {
    const f = fixture();
    truncateSync(f.artifact, 500 * mib + 1);
    expect(f.audit(false).status).toBe(1);
    const result = f.audit();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Desktop base limit: 500.0 MiB");
    const resourceBytes =
      f.descriptor.archives.reduce((sum, entry) => sum + entry.sizeBytes, 0) +
      readFileSync(join(f.resources, "source-server-release.json")).length;
    truncateSync(f.artifact, 500 * mib + resourceBytes + 1);
    expect(f.audit().status).toBe(1);
  });

  it.each(["hash", "size", "platform", "version", "filename", "extra"])(
    "拒绝%s异常，不能用无效资源换取体积额度",
    (failure) => {
      const f = fixture();
      const entry = f.descriptor.archives[0]!;
      if (failure === "hash") entry.sha256 = "0".repeat(64);
      if (failure === "size") entry.sizeBytes += 1;
      if (failure === "platform") f.descriptor.archives.pop();
      if (failure === "version") f.descriptor.version = "old";
      if (failure === "filename") entry.fileName = "../outside.tar.gz";
      if (failure === "extra") writeFileSync(join(f.resources, "unexpected.bin"), "extra");
      f.save();
      expect(f.audit().status).toBe(1);
    },
  );

  it.each(["per-platform", "total"])("%s资源预算有界", (failure) => {
    const f = fixture();
    for (const entry of f.descriptor.archives) {
      entry.sizeBytes = (failure === "per-platform" ? 113 : 101) * mib;
      truncateSync(join(f.resources, entry.fileName), entry.sizeBytes);
    }
    f.save();
    const result = f.audit();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resource budget");
  });

  it("拒绝额外目录和超大清单", () => {
    const f = fixture();
    mkdirSync(join(f.resources, "unexpected"));
    expect(f.audit().status).toBe(1);
    rmSync(join(f.resources, "unexpected"), { recursive: true });
    writeFileSync(join(f.resources, "source-server-release.json"), " ".repeat(64 * 1024 + 1));
    expect(f.audit().status).toBe(1);
  });

  it.skipIf(process.platform === "win32")("拒绝归档符号链接", () => {
    const f = fixture();
    const archivePath = join(f.resources, f.descriptor.archives[0]!.fileName);
    const outside = join(f.root, "outside.tar.gz");
    writeFileSync(outside, readFileSync(archivePath));
    rmSync(archivePath);
    symlinkSync(outside, archivePath);
    expect(f.audit().status).toBe(1);
  });
});

describe("轻量安装包直接预算和体积报告", () => {
  it.each([
    [".exe", 250_000_000],
    [".dmg", 280_000_000],
    [".zip", 280_000_000],
  ] as const)("%s不因独立归档增加额度", (extension, limit) => {
    const f = fixture(extension);
    f.makeLightweight();
    truncateSync(f.artifact, limit);
    expect(f.audit(true, true).status).toBe(0);
    truncateSync(f.artifact, limit + 1);
    expect(f.audit(true, true).status).toBe(1);
    const report = JSON.parse(readFileSync(`${f.artifact}.size-report.json`, "utf8"));
    expect(report.artifact).toMatchObject({ bytes: limit + 1, limitBytes: limit });
    expect(report.resourceMode).toBe("descriptor-only");
  });

  it.each([
    "relative",
    "latest",
    "different-build",
    "extra-archive",
    "missing-target",
    "duplicate-target",
    "empty-urls",
  ])("拒绝%s破坏轻量发布边界", (failure) => {
    const f = fixture();
    f.makeLightweight();
    const first = f.descriptor.archives[0]!;
    if (failure === "relative") first.urls = [first.fileName];
    if (failure === "latest")
      first.urls = [`https://github.com/OpenX123/ZCode/releases/latest/download/${first.fileName}`];
    if (failure === "different-build")
      first.urls = [
        `https://github.com/OpenX123/ZCode/releases/download/build-9-1/${first.fileName}`,
      ];
    if (failure === "extra-archive") writeFileSync(join(f.resources, first.fileName), "unexpected");
    if (failure === "missing-target") f.descriptor.archives.pop();
    if (failure === "duplicate-target") f.descriptor.archives[1]!.target = first.target;
    if (failure === "empty-urls") first.urls = [];
    f.save();
    expect(f.audit(true, true).status).toBe(1);
  });

  it("按ASAR真实头分组区分packed与unpacked，保留资源体积清单", async () => {
    const f = fixture();
    f.makeLightweight();
    const staging = join(f.root, "staging");
    mkdirSync(join(staging, "node_modules", "@example", "runtime"), { recursive: true });
    mkdirSync(join(staging, "out", "renderer"), { recursive: true });
    writeFileSync(join(staging, "node_modules", "@example", "runtime", "index.js"), "runtime");
    writeFileSync(join(staging, "out", "renderer", "index.html"), "renderer");
    const { createPackageWithOptions } = await import("@electron/asar");
    await createPackageWithOptions(staging, join(f.root, "Resources", "app.asar"), {
      unpack: "**/index.js",
    });
    const result = f.audit(true, true);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(`${f.artifact}.size-report.json`, "utf8"));
    expect(report.asarGroups).toEqual(
      expect.arrayContaining([
        { path: "node_modules/@example/runtime", packedBytes: 0, unpackedBytes: 7 },
        { path: "out", packedBytes: 8, unpackedBytes: 0 },
      ]),
    );
    expect(report.installedDirectory.groups).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Resources" })]),
    );
    expect(report.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "app.asar" }),
        expect.objectContaining({ path: "app.asar.unpacked", bytes: 7 }),
      ]),
    );
  });
});
