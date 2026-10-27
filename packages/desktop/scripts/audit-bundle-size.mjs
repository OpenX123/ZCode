#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
} from "@zcode/shared/source-server-release";

const argv = process.argv.slice(2);

function readArg(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

const artifactPath = readArg("--artifact-path");
if (!artifactPath) {
  throw new Error("Usage: audit-bundle-size.mjs --artifact-path <path-to-artifact>");
}

const absoluteArtifactPath = resolve(artifactPath);
const mib = 1024 * 1024;
const descriptorOnly = process.env.ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY === "1";
const baseLimitBytes = descriptorOnly
  ? extname(absoluteArtifactPath).toLowerCase() === ".exe"
    ? 250_000_000
    : 280_000_000
  : 500 * mib;
const perArchiveLimitBytes = 112 * mib;
const remoteResourceLimitBytes = 400 * mib;

async function verifyRemoteResources(directory, version) {
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid remote resource directory");
  const descriptorPath = join(directory, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  const descriptorStat = await lstat(descriptorPath);
  if (!descriptorStat.isFile() || descriptorStat.size > 64 * 1024) {
    throw new Error("Invalid Source Server descriptor file");
  }
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(descriptorPath, "utf8")),
  );
  if (
    descriptor.version !== version ||
    descriptor.archives.length !== SOURCE_SERVER_RELEASE_TARGETS.length
  ) {
    throw new Error(
      "Source Server descriptor must contain the current version and all four platforms",
    );
  }
  const targets = new Set(descriptor.archives.map((archive) => archive.target));
  if (SOURCE_SERVER_RELEASE_TARGETS.some((target) => !targets.has(target))) {
    throw new Error("Source Server descriptor must contain all four unique platforms");
  }
  const expectedFiles = new Set([
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
    ...(descriptorOnly
      ? []
      : SOURCE_SERVER_RELEASE_TARGETS.map((target) => `zcode-server-${target}.tar.gz`)),
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
  ) {
    throw new Error("Unexpected Source Server resource files, directories or symbolic links");
  }
  if (descriptorOnly) {
    let releaseBase = null;
    for (const archive of descriptor.archives) {
      if (archive.urls.length === 0) throw new Error("Missing immutable release URL");
      for (const address of archive.urls) {
        const url = new URL(address);
        const match =
          /^\/[^/]+\/[^/]+\/releases\/download\/(build-\d+-\d+|v1\.0\.(?:0|[1-9]\d*))\/([^/]+)$/.exec(
            url.pathname,
          );
        if (
          url.protocol !== "https:" ||
          url.hostname !== "github.com" ||
          url.username ||
          url.password ||
          url.port ||
          url.search ||
          url.hash ||
          !match ||
          match[2] !== archive.fileName ||
          (match[1].startsWith("v") && match[1] !== `v${version}`)
        )
          throw new Error(`Invalid immutable release URL: ${address}`);
        const base = address.slice(0, address.lastIndexOf("/"));
        if (releaseBase !== null && releaseBase !== base)
          throw new Error("Source Server URLs must identify one immutable build");
        releaseBase = base;
      }
    }
    return {
      bytes: descriptorStat.size,
      declaredBytes: descriptor.archives.reduce((sum, archive) => sum + archive.sizeBytes, 0),
    };
  }
  let bytes = descriptorStat.size;
  for (const archive of descriptor.archives) {
    const fileStat = await lstat(join(directory, archive.fileName));
    if (!fileStat.isFile() || fileStat.size !== archive.sizeBytes) {
      throw new Error(`Source Server size mismatch: ${archive.fileName}`);
    }
    if (fileStat.size > perArchiveLimitBytes) {
      throw new Error(`Source Server per-platform resource budget exceeded: ${archive.fileName}`);
    }
    bytes += fileStat.size;
  }
  if (bytes > remoteResourceLimitBytes)
    throw new Error("Source Server total resource budget exceeded");
  for (const archive of descriptor.archives) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, archive.fileName)))
      hash.update(chunk);
    if (hash.digest("hex") !== archive.sha256) {
      throw new Error(`Source Server SHA-256 mismatch: ${archive.fileName}`);
    }
  }
  return { bytes, declaredBytes: bytes - descriptorStat.size };
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const artifactStat = await stat(absoluteArtifactPath);
const extension = extname(absoluteArtifactPath).toLowerCase();
const remoteAssetsDir = readArg("--remote-assets-dir");
const version = readArg("--version");
if (Boolean(remoteAssetsDir) !== Boolean(version)) {
  throw new Error("--remote-assets-dir and --version must be provided together");
}
if (descriptorOnly && !remoteAssetsDir)
  throw new Error("Lightweight release requires a bundled descriptor");
const remoteResources = remoteAssetsDir
  ? await verifyRemoteResources(resolve(remoteAssetsDir), version)
  : { bytes: 0, declaredBytes: 0 };
const remoteAssetBytes = remoteResources.bytes;
// 离线归档已经 gzip；按校验后的实际字节折算额外额度，不把资源总上限直接加给产物。
// 安装器再次压缩的差异意味着此处是预算折算，不是压缩后桌面体积的精确拆账。
const totalLimitBytes = baseLimitBytes + (descriptorOnly ? 0 : remoteAssetBytes);

console.log(`Artifact: ${absoluteArtifactPath}`);
console.log(`Type: ${extension || "<no-extension>"}`);
console.log(`Size: ${formatMiB(artifactStat.size)}`);
console.log(`Desktop base limit: ${formatMiB(baseLimitBytes)}`);
console.log(`Resource mode: ${descriptorOnly ? "descriptor-only" : "offline"}`);
console.log(
  `Verified bundled resources: ${formatMiB(remoteAssetBytes)}; declared archives: ${formatMiB(remoteResources.declaredBytes)}`,
);
console.log(`Total artifact limit: ${formatMiB(totalLimitBytes)}`);

async function directoryBytes(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  const sizes = await Promise.all(
    (await readdir(path)).map((name) => directoryBytes(join(path, name))),
  );
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

async function asarGroups(path) {
  const file = await open(path, "r");
  try {
    // ASAR 的 Pickle 头先存头长度，再存 JSON 字符串；只读元数据，不把整个 ASAR 加载进内存。
    const prefix = Buffer.alloc(16);
    const { bytesRead } = await file.read(prefix, 0, 16, 0);
    if (bytesRead !== 16) throw new Error("Invalid ASAR header");
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize > headerSize - 8 || headerSize > 64 * mib)
      throw new Error("Invalid ASAR header size");
    const json = Buffer.alloc(jsonSize);
    if ((await file.read(json, 0, jsonSize, 16)).bytesRead !== jsonSize)
      throw new Error("Truncated ASAR header");
    const header = JSON.parse(json.toString("utf8"));
    const groups = new Map();
    function visit(files, prefix = "") {
      for (const [name, entry] of Object.entries(files)) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.files) visit(entry.files, path);
        else if (typeof entry.size === "number") {
          const parts = path.split("/");
          const group =
            parts[0] === "node_modules"
              ? parts.slice(0, parts[1]?.startsWith("@") ? 3 : 2).join("/")
              : parts[0];
          const current = groups.get(group) ?? { path: group, packedBytes: 0, unpackedBytes: 0 };
          current[entry.unpacked ? "unpackedBytes" : "packedBytes"] += entry.size;
          groups.set(group, current);
        }
      }
    }
    visit(header.files);
    return [...groups.values()].sort(
      (left, right) =>
        right.packedBytes + right.unpackedBytes - (left.packedBytes + left.unpackedBytes),
    );
  } finally {
    await file.close();
  }
}

const report = {
  schemaVersion: 1,
  artifact: { path: absoluteArtifactPath, bytes: artifactStat.size, limitBytes: totalLimitBytes },
  resourceMode: descriptorOnly ? "descriptor-only" : "offline",
  bundledResourceBytes: remoteAssetBytes,
  declaredRemoteArchiveBytes: remoteResources.declaredBytes,
  installedDirectory: null,
  resources: [],
  asarGroups: [],
};
if (
  remoteAssetsDir &&
  basename(dirname(resolve(remoteAssetsDir))) === "releases" &&
  basename(dirname(dirname(resolve(remoteAssetsDir)))) === "remote-assets"
) {
  const resourcesDirectory = dirname(dirname(dirname(resolve(remoteAssetsDir))));
  report.resources = await Promise.all(
    (await readdir(resourcesDirectory)).map(async (name) => ({
      path: name,
      bytes: await directoryBytes(join(resourcesDirectory, name)),
    })),
  );
  report.resources.sort((left, right) => right.bytes - left.bytes);
  // macOS 在 Contents 下分别统计 Frameworks/MacOS/Resources；Windows 在 unpacked 根统计。
  const installedRoot = dirname(resourcesDirectory);
  const installedGroups = await Promise.all(
    (await readdir(installedRoot)).map(async (name) => ({
      path: name,
      bytes:
        name === basename(resourcesDirectory)
          ? report.resources.reduce((sum, entry) => sum + entry.bytes, 0)
          : await directoryBytes(join(installedRoot, name)),
    })),
  );
  report.installedDirectory = {
    path: installedRoot,
    logicalBytes: installedGroups.reduce((sum, entry) => sum + entry.bytes, 0),
    groups: installedGroups.sort((left, right) => right.bytes - left.bytes),
  };
  const asarPath = join(resourcesDirectory, "app.asar");
  if (await stat(asarPath).catch(() => null)) report.asarGroups = await asarGroups(asarPath);
}
const reportPath = `${absoluteArtifactPath}.size-report.json`;
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Size report: ${reportPath}`);

if (artifactStat.size > totalLimitBytes) {
  console.error("Bundle size audit failed:");
  console.error(`  - Artifact exceeds ${formatMiB(totalLimitBytes)}`);
  process.exit(1);
}
