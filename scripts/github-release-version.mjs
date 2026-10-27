#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const run = promisify(execFile);
const releaseVersionPattern = /^1\.0\.(0|[1-9]\d*)$/u;

export function nextReleaseVersion(tags) {
  let highest = -1;
  for (const tag of tags) {
    const match = /^v1\.0\.(0|[1-9]\d*)$/u.exec(tag.replace(/^refs\/tags\//u, ""));
    if (!match) continue;
    const patch = Number(match[1]);
    if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Release patch exceeds the supported integer range");
    }
    highest = Math.max(highest, patch);
  }
  return `1.0.${highest + 1}`;
}

export async function applyReleaseVersion({ directory = repoRoot, version }) {
  if (!releaseVersionPattern.test(version)) throw new Error("Expected release version 1.0.<patch>");
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
  const version = official ? nextReleaseVersion(await readTags()) : currentVersion;
  if (!releaseVersionPattern.test(version)) throw new Error("Expected release version 1.0.<patch>");
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
          `repos/${repository}/git/matching-refs/tags/v1.0.`,
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
