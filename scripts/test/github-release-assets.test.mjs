import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  pinReleaseDescriptor,
  releaseBaseUrl,
  verifyDescriptor,
  verifyReleaseAssets,
} from "../github-release-assets.mjs";

const roots = [];
const version = "1.2.3";
const repository = "OpenX123/ZCode";
const tag = "build-8-1";
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

async function fixture(version = "1.2.3", tag = "build-8-1") {
  const directory = await mkdtemp(join(tmpdir(), "ycode-github-release-"));
  roots.push(directory);
  const archives = [];
  for (const target of targets) {
    const content = Buffer.from(`resource-${target}`);
    const fileName = `zcode-server-${target}.tar.gz`;
    await writeFile(join(directory, fileName), content);
    archives.push({
      target,
      version,
      fileName,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      urls: [fileName],
    });
  }
  const descriptor = { schemaVersion: 1, version, archives };
  const save = () =>
    writeFile(join(directory, "source-server-release.json"), JSON.stringify(descriptor));
  await save();
  const options = { directory, version, repository, tag };
  const installers = [
    `YCode-${version}-mac-arm64.dmg`,
    `YCode-${version}-mac-arm64.zip`,
    `YCode-${version}-win-x64.exe`,
  ];
  return { options, descriptor, save, installers };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("plain Node CI 入口加载真实共享 schema 并固定四归档 URL", async () => {
  const { version: currentVersion } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const releaseTag = `v${currentVersion}`;
  const f = await fixture(currentVersion, releaseTag);
  const output = join(f.options.directory, "release-resources");
  const env = { ...process.env, GITHUB_REPOSITORY: repository, RELEASE_TAG: releaseTag };
  // 子进程必须复现 CI 的 plain node，不能借父测试的 tsx 注册掩盖真实加载故障。
  delete env.NODE_OPTIONS;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../github-release-assets.mjs", import.meta.url)),
      "pin",
      "--directory",
      f.options.directory,
      "--output",
      output,
    ],
    { env },
  );
  assert.match(stdout, /\[github-release-assets\] pin: .+ verified/u);
  assert.equal(stderr, "");
  const descriptorName = "source-server-release.json";
  const descriptor = JSON.parse(await readFile(join(output, descriptorName), "utf8"));
  assert.equal(descriptor.version, currentVersion);
  assert.deepEqual(
    descriptor.archives.map((archive) => archive.target),
    targets,
  );
  assert.deepEqual(
    (await readdir(output)).sort(),
    [descriptorName, ...descriptor.archives.map((archive) => archive.fileName)].sort(),
  );
  assert.equal(
    await readFile(join(output, descriptorName), "utf8"),
    await readFile(join(f.options.directory, descriptorName), "utf8"),
  );
  for (const archive of descriptor.archives) {
    const content = await readFile(join(output, archive.fileName));
    assert.deepEqual(content, await readFile(join(f.options.directory, archive.fileName)));
    assert.equal(archive.sizeBytes, content.length);
    assert.equal(archive.sha256, createHash("sha256").update(content).digest("hex"));
    assert.deepEqual(archive.urls, [
      `https://github.com/${repository}/releases/download/${releaseTag}/${archive.fileName}`,
    ]);
  }
});

test("固定每轮 URL，保持相同版本不同 attempt 的内容身份", async () => {
  const f = await fixture();
  const first = await pinReleaseDescriptor(f.options);
  assert.equal(
    first.archives[0].urls[0],
    `https://github.com/${repository}/releases/download/build-8-1/zcode-server-linux-x64.tar.gz`,
  );
  const second = await pinReleaseDescriptor({ ...f.options, tag: "build-8-2" });
  assert.notDeepEqual(first.archives[0].urls, second.archives[0].urls);
  await assert.rejects(verifyDescriptor(f.options), /not pinned/);
});

test("归档篡改或缺少目标时不能生成可发布清单", async () => {
  const f = await fixture();
  await writeFile(join(f.options.directory, f.descriptor.archives[0].fileName), "corrupted");
  await assert.rejects(pinReleaseDescriptor(f.options), /size\/SHA mismatch/);
  f.descriptor.archives.pop();
  await f.save();
  await assert.rejects(pinReleaseDescriptor(f.options), /all four targets/);
});

test("版本不匹配、重复目标和不安全发布身份均被拒绝", async () => {
  const f = await fixture();
  await assert.rejects(pinReleaseDescriptor({ ...f.options, version: "old" }), /current version/);
  f.descriptor.archives[1] = f.descriptor.archives[0];
  await f.save();
  await assert.rejects(pinReleaseDescriptor(f.options), /Duplicate/);
  assert.throws(() => releaseBaseUrl(repository, "latest"));
  assert.throws(() => releaseBaseUrl("../../other", tag));
  // 1.1 起允许 1.<minor> 发版线的正式标签，主版本以外的序列仍拒绝。
  assert.equal(
    releaseBaseUrl(repository, "v1.1.0"),
    `https://github.com/${repository}/releases/download/v1.1.0`,
  );
  assert.throws(() => releaseBaseUrl(repository, "v2.0.0"));
  assert.throws(() => releaseBaseUrl(repository, "v1.1.01"));
});

test("两目标三份安装文件和四归档齐全后才输出逐文件 SHA256SUMS", async () => {
  const f = await fixture();
  await pinReleaseDescriptor(f.options);
  await assert.rejects(verifyReleaseAssets(f.options), /exactly three installers/);
  for (const name of f.installers)
    await writeFile(join(f.options.directory, name), `installer-${name}`);
  const names = await verifyReleaseAssets(f.options);
  assert.equal(names.length, 9);
  const checksums = await readFile(join(f.options.directory, "SHA256SUMS"), "utf8");
  assert.equal(checksums.trim().split("\n").length, 9);
  assert.match(checksums, /^[a-f0-9]{64}  YCode-/);
  const manifest = JSON.parse(
    await readFile(join(f.options.directory, "ycode-update.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, version);
  assert.equal(manifest.releaseUrl, `https://github.com/${repository}/releases/tag/${tag}`);
  assert.equal(manifest.assets.length, 2);
  assert.deepEqual(
    manifest.assets.map((asset) => `${asset.platform}-${asset.arch}`),
    ["darwin-arm64", "win32-x64"],
  );
  for (const asset of manifest.assets) {
    const content = await readFile(join(f.options.directory, asset.fileName));
    assert.equal(asset.size, content.length);
    assert.equal(asset.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(
      asset.url,
      `https://github.com/${repository}/releases/download/${tag}/${asset.fileName}`,
    );
    assert.equal(asset.fileName.endsWith(asset.platform === "darwin" ? ".dmg" : ".exe"), true);
  }
  const manifestContent = await readFile(join(f.options.directory, "ycode-update.json"));
  assert.ok(
    checksums.includes(
      `${createHash("sha256").update(manifestContent).digest("hex")}  ycode-update.json`,
    ),
  );
});

test("相同应用版本的其他构建 URL 不能混入最终 Release", async () => {
  const f = await fixture();
  await pinReleaseDescriptor({ ...f.options, tag: "build-9-1" });
  await assert.rejects(verifyReleaseAssets(f.options), /not pinned/);
});

test("独立远程附件仍执行平台与总量预算", async () => {
  const f = await fixture();
  f.descriptor.archives[0].sizeBytes = 113 * 1024 * 1024;
  await f.save();
  await assert.rejects(pinReleaseDescriptor(f.options), /per-platform resource budget/);
  for (const archive of f.descriptor.archives) archive.sizeBytes = 101 * 1024 * 1024;
  await f.save();
  await assert.rejects(pinReleaseDescriptor(f.options), /total resource budget/);
});

test("正式v1.0版本固定资源URL，禁止tag与内部版本不一致", async () => {
  const f = await fixture("1.0.0", "v1.0.0");
  const descriptor = await pinReleaseDescriptor(f.options);
  assert.equal(
    descriptor.archives[0].urls[0],
    `https://github.com/${repository}/releases/download/v1.0.0/zcode-server-linux-x64.tar.gz`,
  );
  await verifyDescriptor(f.options);
  await assert.rejects(pinReleaseDescriptor({ ...f.options, tag: "v1.0.1" }), /tag must match/);
  await assert.rejects(verifyDescriptor({ ...f.options, tag: "v1.0.1" }), /tag must match/);
});

test("最终白名单允许重新生成更新清单但拒绝其他文件", async () => {
  const f = await fixture("1.0.1", "v1.0.1");
  await pinReleaseDescriptor(f.options);
  for (const name of f.installers) await writeFile(join(f.options.directory, name), name);
  await verifyReleaseAssets(f.options);
  await writeFile(join(f.options.directory, "ycode-update.json"), "tampered");
  await verifyReleaseAssets(f.options);
  const manifest = JSON.parse(
    await readFile(join(f.options.directory, "ycode-update.json"), "utf8"),
  );
  assert.equal(manifest.version, "1.0.1");
  await writeFile(join(f.options.directory, "unexpected.json"), "unexpected");
  await assert.rejects(verifyReleaseAssets(f.options), /exactly three installers/);
});

test("已移除的桌面架构不得混入发布产物", async () => {
  for (const suffix of ["mac-x64.dmg", "mac-x64.zip", "win-arm64.exe"]) {
    const f = await fixture();
    await pinReleaseDescriptor(f.options);
    for (const name of f.installers) await writeFile(join(f.options.directory, name), name);
    await writeFile(join(f.options.directory, `YCode-${version}-${suffix}`), "retired");
    await assert.rejects(verifyReleaseAssets(f.options), /exactly three installers/);
  }
});
