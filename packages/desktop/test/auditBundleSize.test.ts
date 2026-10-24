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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zcode-size-audit-"));
  roots.push(root);
  const resources = join(root, "remote-assets");
  mkdirSync(resources);
  const artifact = join(root, "app.zip");
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
  const audit = (withResources = true) =>
    spawnSync(
      process.execPath,
      [
        script,
        "--artifact-path",
        artifact,
        ...(withResources ? ["--remote-assets-dir", resources, "--version", "1.2.3"] : []),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  return { root, artifact, resources, descriptor, save, audit };
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
