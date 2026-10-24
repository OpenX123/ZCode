#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
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
const baseLimitBytes = 500 * mib;
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
  const expectedFiles = new Set([
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
    ...SOURCE_SERVER_RELEASE_TARGETS.map((target) => `zcode-server-${target}.tar.gz`),
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
  ) {
    throw new Error("Unexpected Source Server resource files, directories or symbolic links");
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
  return bytes;
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
const remoteAssetBytes = remoteAssetsDir
  ? await verifyRemoteResources(resolve(remoteAssetsDir), version)
  : 0;
// 离线归档已经 gzip；按校验后的实际字节折算额外额度，不把资源总上限直接加给产物。
// 安装器再次压缩的差异意味着此处是预算折算，不是压缩后桌面体积的精确拆账。
const totalLimitBytes = baseLimitBytes + remoteAssetBytes;

console.log(`Artifact: ${absoluteArtifactPath}`);
console.log(`Type: ${extension || "<no-extension>"}`);
console.log(`Size: ${formatMiB(artifactStat.size)}`);
console.log(`Desktop base limit: ${formatMiB(baseLimitBytes)}`);
console.log(
  `Verified offline resources: ${formatMiB(remoteAssetBytes)} (maximum 400 MiB; 112 MiB/platform)`,
);
console.log(`Total artifact limit: ${formatMiB(totalLimitBytes)}`);

if (artifactStat.size > totalLimitBytes) {
  console.error("Bundle size audit failed:");
  console.error(`  - Artifact exceeds ${formatMiB(totalLimitBytes)}`);
  process.exit(1);
}
