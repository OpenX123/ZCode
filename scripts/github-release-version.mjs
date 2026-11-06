#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const run = promisify(execFile);
// 1.1 起按 package.json 的 1.<minor> 发版线递增 patch（ADR 0005）；主版本固定为 1。
const releaseVersionPattern = /^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const releaseTagPattern = /^v1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function safeVersionPart(value) {
  const part = Number(value);
  if (!Number.isSafeInteger(part) || part >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Release patch exceeds the supported integer range");
  }
  return part;
}

/** 发版线取自 package.json 的 1.<minor>；缺省为 1.0 线，保持 1.0.x 的既有行为。 */
export function releaseLine(currentVersion = "1.0.0") {
  const match = releaseVersionPattern.exec(currentVersion);
  if (!match) throw new Error("Expected release version 1.<minor>.<patch>");
  return safeVersionPart(match[1]);
}

export function nextReleaseVersion(tags, currentVersion = "1.0.0") {
  const minor = releaseLine(currentVersion);
  let highest = -1;
  let highestMinor = -1;
  for (const tag of tags) {
    const match = releaseTagPattern.exec(tag.replace(/^refs\/tags\//u, ""));
    if (!match) continue;
    const tagMinor = safeVersionPart(match[1]);
    const patch = safeVersionPart(match[2]);
    highestMinor = Math.max(highestMinor, tagMinor);
    if (tagMinor === minor) highest = Math.max(highest, patch);
  }
  // 已有更高发版线的正式标签时拒绝分配，避免向用户发布更低的版本号。
  if (highestMinor > minor) {
    throw new Error(`Release line 1.${minor} is older than published 1.${highestMinor}`);
  }
  return `1.${minor}.${highest + 1}`;
}

export async function applyReleaseVersion({ directory = repoRoot, version }) {
  if (!releaseVersionPattern.test(version))
    throw new Error("Expected release version 1.<minor>.<patch>");
  const file = join(directory, "package.json");
  const packageJson = JSON.parse(await readFile(file, "utf8"));
  packageJson.version = version;
  await writeFile(file, `${JSON.stringify(packageJson, null, 2)}\n`);
  return version;
}

export async function allocateReleaseIdentity({
  official,
  currentVersion,
  repository,
  runNumber,
  runAttempt,
  readTags,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("Expected GitHub repository owner/name");
  if (!/^\d+$/u.test(runNumber) || !/^\d+$/u.test(runAttempt))
    throw new Error("Missing workflow run identity");
  const version = official ? nextReleaseVersion(await readTags(), currentVersion) : currentVersion;
  if (!releaseVersionPattern.test(version))
    throw new Error("Expected release version 1.<minor>.<patch>");
  return { version, tag: official ? `v${version}` : `build-${runNumber}-${runAttempt}` };
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "apply") {
    const version = await applyReleaseVersion({ version: value ?? process.env.RELEASE_VERSION });
    console.log(`[release-version] applied ${version}`);
    return;
  }
  if (command !== "allocate") throw new Error(`Unknown release version command: ${command}`);
  const { version: currentVersion } = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const repository = process.env.GITHUB_REPOSITORY;
  const identity = await allocateReleaseIdentity({
    official: process.env.YCODE_OFFICIAL_RELEASE === "true",
    currentVersion,
    repository,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    readTags: async () => {
      const { stdout } = await run(
        "gh",
        [
          "api",
          "--paginate",
          // 读取全部 1.x 正式标签，nextReleaseVersion 据此拒绝回退到更低的发版线。
          `repos/${repository}/git/matching-refs/tags/v1.`,
          "--jq",
          ".[].ref",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout.split(/\r?\n/u).filter(Boolean);
    },
  });
  await applyReleaseVersion({ version: identity.version });
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GITHUB_OUTPUT");
  await appendFile(process.env.GITHUB_OUTPUT, `version=${identity.version}\ntag=${identity.tag}\n`);
  console.log(`[release-version] allocated ${identity.tag}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
