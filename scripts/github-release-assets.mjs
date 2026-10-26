#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const requireFromDesktop = createRequire(join(repoRoot, "packages/desktop/package.json"));
const {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
} = await import(
  pathToFileURL(requireFromDesktop.resolve("@zcode/shared/source-server-release")).href
);

export function releaseBaseUrl(repository, tag) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^build-\d+-\d+$/u.test(tag)) {
    throw new Error("Expected repository owner/name and immutable build-<run>-<attempt> tag");
  }
  return `https://github.com/${repository}/releases/download/${tag}`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyDescriptor({
  directory,
  version,
  repository,
  tag,
  verifyArchives = false,
}) {
  const path = join(directory, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 64 * 1024)
    throw new Error("Invalid release descriptor file");
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (
    descriptor.version !== version ||
    descriptor.archives.length !== SOURCE_SERVER_RELEASE_TARGETS.length
  ) {
    throw new Error("Release descriptor must contain the current version and all four targets");
  }
  const base = repository || tag ? releaseBaseUrl(repository, tag) : null;
  const mib = 1024 * 1024;
  if (
    descriptor.archives.reduce((sum, archive) => sum + archive.sizeBytes, metadata.size) >
    400 * mib
  ) {
    throw new Error("Source Server total resource budget exceeded");
  }
  for (const archive of descriptor.archives) {
    if (archive.sizeBytes > 112 * mib) {
      throw new Error(`Source Server per-platform resource budget exceeded: ${archive.fileName}`);
    }
    if (base && (archive.urls.length !== 1 || archive.urls[0] !== `${base}/${archive.fileName}`)) {
      throw new Error(`Release URL is not pinned to this build: ${archive.fileName}`);
    }
    if (verifyArchives) {
      const archivePath = join(directory, archive.fileName);
      const fileStat = await lstat(archivePath);
      if (
        !fileStat.isFile() ||
        fileStat.size !== archive.sizeBytes ||
        (await sha256File(archivePath)) !== archive.sha256
      ) {
        throw new Error(`Release archive size/SHA mismatch: ${archive.fileName}`);
      }
    }
  }
  return descriptor;
}

export async function pinReleaseDescriptor({ directory, output, version, repository, tag }) {
  const base = releaseBaseUrl(repository, tag);
  const descriptor = await verifyDescriptor({ directory, version, verifyArchives: true });
  for (const archive of descriptor.archives) archive.urls = [`${base}/${archive.fileName}`];
  await writeFile(
    join(directory, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  if (output) {
    await mkdir(output, { recursive: true });
    for (const name of [
      SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
      ...descriptor.archives.map((archive) => archive.fileName),
    ]) {
      await copyFile(join(directory, name), join(output, name));
    }
  }
  return descriptor;
}

export async function verifyReleaseAssets(options) {
  const descriptor = await verifyDescriptor({ ...options, verifyArchives: true });
  const installers = [
    ...["arm64", "x64"].flatMap((arch) =>
      ["dmg", "zip"].map((extension) => `YCode-${options.version}-mac-${arch}.${extension}`),
    ),
    ...["arm64", "x64"].map((arch) => `YCode-${options.version}-win-${arch}.exe`),
  ];
  const names = [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
    ...descriptor.archives.map((archive) => archive.fileName),
    ...installers,
  ].sort();
  const entries = await readdir(options.directory, { withFileTypes: true });
  if (
    entries.length !== names.length ||
    entries.some((entry) => !entry.isFile() || !names.includes(entry.name))
  ) {
    throw new Error(
      "Release must contain exactly six installers, four remote archives and one descriptor",
    );
  }
  const lines = [];
  for (const name of names) {
    const file = join(options.directory, name);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size === 0)
      throw new Error(`Invalid release asset: ${name}`);
    lines.push(`${await sha256File(file)}  ${name}`);
  }
  await writeFile(join(options.directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return names;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const arg = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const options = {
    directory: resolve(
      arg("--directory") ?? join(repoRoot, "packages/desktop/mock-cdn/releases", version),
    ),
    output: arg("--output") ? resolve(arg("--output")) : undefined,
    version,
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
  };
  // GitHub 身份必须显式存在，避免漏配后把相对 URL 当作可分发清单。
  releaseBaseUrl(options.repository, options.tag);
  if (command === "pin") await pinReleaseDescriptor(options);
  else if (command === "verify-descriptor") {
    await verifyDescriptor(options);
    const entries = await readdir(options.directory);
    if (entries.length !== 1 || entries[0] !== SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME) {
      throw new Error("Lightweight desktop input must contain only the release descriptor");
    }
  } else if (command === "verify-release") await verifyReleaseAssets(options);
  else throw new Error(`Unknown release asset command: ${command}`);
  console.log(`[github-release-assets] ${command}: ${basename(options.directory)} verified`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
