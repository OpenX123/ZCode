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
  commitSha,
  resolveTagCommit,
  releaseExists,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("Expected GitHub repository owner/name");
  if (!/^\d+$/u.test(runNumber) || !/^\d+$/u.test(runAttempt))
    throw new Error("Missing workflow run identity");
  let version = currentVersion;
  if (official) {
    const tags = await readTags();
    version = nextReleaseVersion(tags, currentVersion);
    const reserved = await reusablePreCreatedTag({
      tags,
      nextVersion: version,
      commitSha,
      resolveTagCommit,
      releaseExists,
    });
    if (reserved) version = reserved.slice(1);
  }
  if (!releaseVersionPattern.test(version))
    throw new Error("Expected release version 1.<minor>.<patch>");
  return { version, tag: official ? `v${version}` : `build-${runNumber}-${runAttempt}` };
}

/**
 * 原因：GITHUB_TOKEN 创建标签时，若提交区间含 workflow 改动会被 GitHub 以 HTTP 403 拒绝。
 * 维护者因此用本机 gh 预先创建正式标签；本线最高标签已指向当前提交且尚无公开 Release 时，
 * 视为预留给本次构建，复用该版本而不是再跳到下一 patch。
 */
async function reusablePreCreatedTag({
  tags,
  nextVersion,
  commitSha,
  resolveTagCommit,
  releaseExists,
}) {
  if (!commitSha || !resolveTagCommit || !releaseExists) return null;
  const match = releaseVersionPattern.exec(nextVersion);
  const patch = safeVersionPart(match[2]);
  if (patch === 0) return null;
  const candidate = `v1.${match[1]}.${patch - 1}`;
  if (!tags.some((tag) => tag.replace(/^refs\/tags\//u, "") === candidate)) return null;
  if ((await resolveTagCommit(candidate)) !== commitSha) return null;
  if (await releaseExists(candidate)) return null;
  return candidate;
}

/**
 * 发布前确认正式标签：已存在且指向当前提交则直接使用（维护者预建）；指向其他提交时明确失败；
 * 不存在才尝试用当前令牌创建，失败时给出本机预建命令。从不覆盖已有标签。
 */
export async function ensureReleaseTag({
  repository,
  tag,
  commitSha,
  resolveTagCommit,
  createTag,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("Expected GitHub repository owner/name");
  if (!releaseTagPattern.test(tag)) throw new Error("Expected release tag v1.<minor>.<patch>");
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? "")) throw new Error("Expected full commit SHA");
  const existing = await resolveTagCommit(tag);
  if (existing === commitSha) return "existing";
  if (existing) {
    throw new Error(
      `Tag ${tag} already points to ${existing}, not this build ${commitSha}. ` +
        "Existing tags are never overwritten; rerun all jobs to allocate the next patch " +
        "or have a maintainer fix the tag manually.",
    );
  }
  try {
    await createTag(tag, commitSha);
    return "created";
  } catch (error) {
    // 并发或重试时标签可能已被创建；只要指向本提交即可继续。
    if ((await resolveTagCommit(tag).catch(() => null)) === commitSha) return "existing";
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot create ${tag} with the workflow token (${reason.trim()}). ` +
        `Pre-create it locally, then rerun this workflow: gh api --method POST ` +
        `repos/${repository}/git/refs -f ref=refs/tags/${tag} -f sha=${commitSha}`,
    );
  }
}

/**
 * 本机构建身份：版本只来自已检出的根 package.json，运行 ref 必须恰为对应正式标签，
 * 避免再在 workflow 中写死版本号或构建与标签不一致的提交。
 */
export function localReleaseIdentity({ ref, version }) {
  if (!releaseVersionPattern.test(version ?? ""))
    throw new Error("Expected package.json version 1.<minor>.<patch>");
  const tag = `v${version}`;
  if (ref !== `refs/tags/${tag}`) {
    throw new Error(
      `Local release builds must run on refs/tags/${tag} (package.json ${version}); got ${ref}`,
    );
  }
  return { version, tag };
}

export const LOCAL_SOURCE_WORKFLOW_PATH = ".github/workflows/build-macos-local.yml";

/** Windows 本机构建只接受同一提交上 Mac 本机 workflow 生成的 descriptor。 */
export async function verifySourceRun({ runId, commitSha, fetchRun }) {
  if (!/^[1-9]\d{0,19}$/u.test(runId ?? "")) throw new Error("Expected numeric source run id");
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? "")) throw new Error("Expected full commit SHA");
  const sourceRun = await fetchRun(runId);
  if (sourceRun?.path !== LOCAL_SOURCE_WORKFLOW_PATH) {
    throw new Error(`Source run ${runId} is not ${LOCAL_SOURCE_WORKFLOW_PATH}`);
  }
  if (sourceRun.head_sha !== commitSha) {
    throw new Error(
      `Source run ${runId} built ${sourceRun.head_sha}, not this commit ${commitSha}`,
    );
  }
  return sourceRun;
}

function isNotFound(error) {
  return /HTTP 404|Not Found/u.test(`${error?.stderr ?? ""}${error?.message ?? ""}`);
}

/** 解析标签最终指向的提交；附注标签逐层解引用，不存在时返回 null。 */
async function ghResolveTagCommit(repository, tag) {
  if (!releaseTagPattern.test(tag)) throw new Error("Expected release tag v1.<minor>.<patch>");
  let object;
  try {
    const { stdout } = await run("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`]);
    object = JSON.parse(stdout).object;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    const { stdout } = await run("gh", ["api", `repos/${repository}/git/tags/${object.sha}`]);
    object = JSON.parse(stdout).object;
  }
  if (object?.type !== "commit" || !/^[0-9a-f]{40}$/u.test(object.sha))
    throw new Error(`Tag ${tag} does not resolve to a commit`);
  return object.sha;
}

async function ghReleaseExists(repository, tag) {
  try {
    await run("gh", ["api", `repos/${repository}/releases/tags/${tag}`]);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "apply") {
    const version = await applyReleaseVersion({ version: value ?? process.env.RELEASE_VERSION });
    console.log(`[release-version] applied ${version}`);
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (command === "local-identity") {
    const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const identity = localReleaseIdentity({
      ref: process.env.GITHUB_REF,
      version,
    });
    if (!process.env.GITHUB_ENV) throw new Error("Missing GITHUB_ENV");
    await appendFile(
      process.env.GITHUB_ENV,
      `RELEASE_VERSION=${identity.version}\nRELEASE_TAG=${identity.tag}\n`,
    );
    console.log(`[release-version] local build ${identity.tag}`);
    return;
  }
  if (command === "verify-source-run") {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? ""))
      throw new Error("Expected GitHub repository owner/name");
    const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const sourceRun = await verifySourceRun({
      runId: process.env.SOURCE_RUN_ID,
      commitSha: process.env.GITHUB_SHA,
      fetchRun: async (runId) => {
        const response = await fetch(`${apiUrl}/repos/${repository}/actions/runs/${runId}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          },
        });
        if (!response.ok)
          throw new Error(`Cannot read source run ${runId}: HTTP ${response.status}`);
        return await response.json();
      },
    });
    console.log(`[release-version] source run ${sourceRun.id} matches ${sourceRun.head_sha}`);
    return;
  }
  if (command === "reserve-tag") {
    const tag = process.env.RELEASE_TAG;
    const result = await ensureReleaseTag({
      repository,
      tag,
      commitSha: process.env.GITHUB_SHA,
      resolveTagCommit: (name) => ghResolveTagCommit(repository, name),
      createTag: (name, sha) =>
        run("gh", [
          "api",
          "--method",
          "POST",
          `repos/${repository}/git/refs`,
          "-f",
          `ref=refs/tags/${name}`,
          "-f",
          `sha=${sha}`,
        ]),
    });
    console.log(`[release-version] tag ${tag}: ${result}`);
    return;
  }
  if (command !== "allocate") throw new Error(`Unknown release version command: ${command}`);
  const { version: currentVersion } = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const identity = await allocateReleaseIdentity({
    official: process.env.YCODE_OFFICIAL_RELEASE === "true",
    currentVersion,
    repository,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    commitSha: process.env.GITHUB_SHA,
    resolveTagCommit: (tag) => ghResolveTagCommit(repository, tag),
    releaseExists: (tag) => ghReleaseExists(repository, tag),
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
