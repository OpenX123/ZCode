import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { EnvInfo } from "@zcode/contracts";
import { getWindowsEnvValue, splitWindowsPath } from "../exec/windows-executable.js";

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_COMMAND = "git";
const GIT_STATUS_NOT_REPO = "not_repo" as const;
const GIT_STATUS_CLEAN = "clean" as const;
const GIT_STATUS_DIRTY = "dirty" as const;
const MAX_RECENT_COMMITS = 5;
const DEFAULT_MAIN_BRANCH = "main";
const DEFAULT_MAIN_BRANCH_CANDIDATES = [DEFAULT_MAIN_BRANCH, "master"] as const;
const MAX_GIT_STATUS_CONTEXT_CHARS = 2000;
const GIT_DIRECTORY_ENTRY = ".git";
const DETACHED_HEAD_BRANCH = "HEAD";
const ORIGIN_REMOTE_REF_PREFIX = "refs/remotes/origin/";
const ORIGIN_HEAD_REF = `${ORIGIN_REMOTE_REF_PREFIX}HEAD`;
const GIT_FOR_EACH_REF_FIELD_SEPARATOR = "\0";
// `status --branch` 的首行：`## main...origin/main [ahead 1]`、`## HEAD (no branch)`、
// `## No commits yet on main`（旧版 git 为 `## Initial commit on main`）。
const STATUS_BRANCH_HEADER_PREFIX = "## ";
const STATUS_DETACHED_HEADER = "HEAD (no branch)";
const STATUS_UNBORN_HEADER_PREFIXES = ["No commits yet on ", "Initial commit on "] as const;
const STATUS_UPSTREAM_SEPARATOR = "...";
const STATUS_TRACKING_INFO_SEPARATOR = " [";
const GIT_DIR_FILE_PREFIX = "gitdir:";
const GIT_SYMBOLIC_REF_PREFIX = "ref:";
// 与工作区无关的快照字段按仓库缓存；一个 CLI 进程通常只服务一个 workspace，上限防异常增长。
const MAX_HEAD_SNAPSHOT_CACHE_ENTRIES = 32;

// 状态行与分支名合并为一条命令：`--branch` 只多出首行，其余行与 `--short` 字节相同。
// `status.aheadBehind=false` 避免为首行计算领先/落后计数；旧版 git 不认识该配置时会忽略它。
const GIT_STATUS_ARGS = [
  "--no-optional-locks",
  "-c",
  "status.aheadBehind=false",
  "status",
  "--short",
  "--branch",
  "--ignore-submodules=dirty",
] as const;
// 一次读出 origin/HEAD 指向与 origin/main、origin/master 是否存在；指向已删除分支的
// origin/HEAD 不会被列出，与原先 symbolic-ref + show-ref 校验的结论一致。
const GIT_MAIN_BRANCH_REFS_ARGS = [
  "for-each-ref",
  `--format=%(refname)%00%(symref)`,
  ORIGIN_HEAD_REF,
  ...DEFAULT_MAIN_BRANCH_CANDIDATES.map((branch) => `${ORIGIN_REMOTE_REF_PREFIX}${branch}`),
] as const;
const GIT_USER_ARGS = ["config", "user.name"] as const;
const GIT_RECENT_COMMITS_ARGS = [
  "--no-optional-locks",
  "log",
  "--oneline",
  "-n",
  String(MAX_RECENT_COMMITS),
] as const;
const GIT_CURRENT_BRANCH_ARGS = ["symbolic-ref", "--short", "-q", "HEAD"] as const;

/** 与工作区文件无关、只随 HEAD / 引用 / 配置变化的快照字段。 */
interface HeadDerivedGitSnapshot {
  gitMainBranch: string;
  gitUser: string | undefined;
  recentCommits: string[];
}

const headSnapshotCache = new Map<string, { revision: string; snapshot: HeadDerivedGitSnapshot }>();

const execFile = promisify(execFileCallback);

interface GitCommandResult {
  // git 自己的退出码；timeout、取消、无法启动时没有退出码。
  code: number | undefined;
  stderr: string;
  stdout: string;
}

interface ExecFileFailure extends Error {
  code?: number | string | null;
}

/**
 * 从目录向上走到文件系统根，返回第一个含 `.git` 的目录。`.git` 是目录或文件都算
 * （worktree / submodule 的 gitdir 文件）；symlink 按目标判断，目标不存在不算。
 * 修复原因：原来用 git rev-parse 判定，超时、取消、没装 git 都没有结论，调用方只能把
 * 结论写成"不是仓库"或每次请求重跑 git。是否在仓库只是一个文件系统事实，不需要启动 git。
 */
export async function findGitRoot(directory: string): Promise<string | undefined> {
  for (let current = directory; ; current = dirname(current)) {
    if (await hasGitEntry(current)) return current;
    // 盘符根、UNC 根与 POSIX 根的 dirname 都是它自己。
    if (dirname(current) === current) return undefined;
  }
}

/**
 * 是否在仓库：从目录的真实路径向上查找 `.git`，git 自己也在真实路径下运行。
 * 修复原因：原来从打开时的路径（链接本身的位置）向上查找。指向仓库子目录的链接被判为"不是仓库"；
 * 仓库里指向外部的链接被判为仓库，git 命令全部失败，模型看到默认值拼成的假快照。
 * 真实路径读不到（例如目录已删除）时按打开时的路径查找。
 */
export async function resolveIsGitRepository(
  workingDirectory: string,
  // 调用方已从打开时的路径查找过时传入结果；真实路径与它相同时直接复用，不再查找。
  givenPathGitRoot?: string | null,
): Promise<boolean> {
  return (await resolveGitRepositoryRoot(workingDirectory, givenPathGitRoot)) !== undefined;
}

/** 与 resolveIsGitRepository 同一判断，但返回真实路径上找到的仓库根，供快照缓存定位 git 目录。 */
export async function resolveGitRepositoryRoot(
  workingDirectory: string,
  givenPathGitRoot?: string | null,
): Promise<string | undefined> {
  const realPath = await realpath(workingDirectory).catch(() => workingDirectory);
  if (givenPathGitRoot !== undefined && realPath === workingDirectory) {
    return givenPathGitRoot ?? undefined;
  }
  return await findGitRoot(realPath);
}

export async function resolveGitSnapshot(
  workingDirectory: string,
  signal?: AbortSignal,
  // 调用方已经查找过 `.git` 时传入结论，不再向上查找。
  isGitRepository?: boolean,
  // 调用方已知的仓库根（真实路径）；缺省且未传 isGitRepository 时由本函数顺带求出。
  knownGitRoot?: string,
): Promise<Partial<EnvInfo>> {
  let gitRoot = knownGitRoot;
  if (isGitRepository === undefined && gitRoot === undefined) {
    gitRoot = await resolveGitRepositoryRoot(workingDirectory);
    if (gitRoot === undefined) return { isGitRepository: false, gitStatus: GIT_STATUS_NOT_REPO };
  } else if (isGitRepository === false) {
    return { isGitRepository: false, gitStatus: GIT_STATUS_NOT_REPO };
  }

  // 修复原因：每个 runtime 的首轮上下文过去启动 5–8 个 git.exe（1.0.5：p50 0.25s / p90 0.74s）。
  // 现在状态行与分支名合并为一条 status --branch，主分支探测合并为一条 for-each-ref；与工作区
  // 无关的字段按仓库的 HEAD 与索引修订在进程内缓存，命中时只运行 status。工作区改动不会改变
  // HEAD/索引修订，所以状态行每次都实时读取，保持"会话开始时的快照"语义。命令互不依赖并行执行。
  const revision = gitRoot ? await readHeadSnapshotRevision(gitRoot) : undefined;
  const cached =
    revision && gitRoot ? headSnapshotCache.get(gitRoot) : undefined;
  const reusable = cached && cached.revision === revision ? cached.snapshot : undefined;
  const [statusResult, headSnapshot] = await Promise.all([
    execGitNoThrow([...GIT_STATUS_ARGS], workingDirectory, signal),
    reusable
      ? Promise.resolve({ cacheable: false, snapshot: reusable })
      : readHeadDerivedSnapshot(workingDirectory, signal),
  ]);
  if (revision && gitRoot && headSnapshot.cacheable) {
    rememberHeadSnapshot(gitRoot, revision, headSnapshot.snapshot);
  }

  const { branchHeader, statusOutput } = splitStatusBranchHeader(statusResult);
  // status 失败（超时、退出码非 0）时原先的分支名仍由独立命令读取；回退保持同一结果。
  const gitBranch =
    branchHeader === undefined
      ? await resolveGitBranch(workingDirectory, signal)
      : parseStatusBranchHeader(branchHeader);
  const gitStatusLines = splitGitStatusForContext(statusOutput.trim());

  return {
    isGitRepository: true,
    gitBranch,
    gitMainBranch: headSnapshot.snapshot.gitMainBranch,
    gitUser: headSnapshot.snapshot.gitUser,
    gitStatus: gitStatusLines.length > 0 ? GIT_STATUS_DIRTY : GIT_STATUS_CLEAN,
    gitStatusLines,
    recentCommits: headSnapshot.snapshot.recentCommits,
  };
}

async function readHeadDerivedSnapshot(
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<{ cacheable: boolean; snapshot: HeadDerivedGitSnapshot }> {
  const [refsResult, userResult, logResult] = await Promise.all([
    execGitNoThrow([...GIT_MAIN_BRANCH_REFS_ARGS], workingDirectory, signal),
    execGitNoThrow([...GIT_USER_ARGS], workingDirectory, signal),
    execGitNoThrow([...GIT_RECENT_COMMITS_ARGS], workingDirectory, signal),
  ]);
  const gitUser = userResult.stdout.trim();
  return {
    // 只缓存有确定结论的结果：超时、取消或 git 无法启动（没有退出码）时下次重新读取。
    cacheable: [refsResult, userResult, logResult].every((result) => result.code !== undefined),
    snapshot: {
      gitMainBranch: resolveMainBranchFromRefs(refsResult.stdout),
      gitUser: gitUser ? gitUser : undefined,
      recentCommits: splitNonEmptyLines(logResult.stdout).slice(0, MAX_RECENT_COMMITS),
    },
  };
}

/** origin/HEAD 指向的 origin 分支 → main → master → 缺省 main，与原先的候选顺序相同。 */
function resolveMainBranchFromRefs(output: string): string {
  const refs = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const [refName, symref = ""] = line.split(GIT_FOR_EACH_REF_FIELD_SEPARATOR);
    if (refName) refs.set(refName.trim(), symref.trim());
  }
  const originHeadTarget = refs.get(ORIGIN_HEAD_REF);
  // 被列出的 origin/HEAD 已解析成功，说明它指向的 origin 分支存在。
  if (originHeadTarget?.startsWith(ORIGIN_REMOTE_REF_PREFIX)) {
    const branch = originHeadTarget.slice(ORIGIN_REMOTE_REF_PREFIX.length);
    if (branch) return branch;
  }
  for (const candidate of DEFAULT_MAIN_BRANCH_CANDIDATES) {
    if (refs.has(`${ORIGIN_REMOTE_REF_PREFIX}${candidate}`)) return candidate;
  }
  return DEFAULT_MAIN_BRANCH;
}

function splitStatusBranchHeader(result: GitCommandResult): {
  branchHeader: string | undefined;
  statusOutput: string;
} {
  if (result.code !== 0) return { branchHeader: undefined, statusOutput: "" };
  const output = result.stdout;
  if (!output.startsWith(STATUS_BRANCH_HEADER_PREFIX)) {
    return { branchHeader: undefined, statusOutput: output };
  }
  const newlineIndex = output.indexOf("\n");
  const headerLine = newlineIndex === -1 ? output : output.slice(0, newlineIndex);
  return {
    branchHeader: headerLine.replace(/\r$/u, "").slice(STATUS_BRANCH_HEADER_PREFIX.length),
    statusOutput: newlineIndex === -1 ? "" : output.slice(newlineIndex + 1),
  };
}

/** 分支名不能含 `..` 与空格（git check-ref-format），按 `...` 与 ` [` 切分是安全的。 */
function parseStatusBranchHeader(header: string): string {
  if (header === STATUS_DETACHED_HEADER) return DETACHED_HEAD_BRANCH;
  let branch = header;
  const unbornPrefix = STATUS_UNBORN_HEADER_PREFIXES.find((prefix) => branch.startsWith(prefix));
  if (unbornPrefix) branch = branch.slice(unbornPrefix.length);
  const upstreamIndex = branch.indexOf(STATUS_UPSTREAM_SEPARATOR);
  if (upstreamIndex >= 0) branch = branch.slice(0, upstreamIndex);
  const trackingIndex = branch.indexOf(STATUS_TRACKING_INFO_SEPARATOR);
  if (trackingIndex >= 0) branch = branch.slice(0, trackingIndex);
  return branch.trim() || DETACHED_HEAD_BRANCH;
}

/**
 * 仓库 HEAD 修订：git 目录、HEAD 内容、HEAD 指向的松散引用、packed-refs、索引与仓库配置的统计。
 * 任一读取失败（reftable、权限、异常布局）都不缓存，按未命中处理。
 */
async function readHeadSnapshotRevision(gitRoot: string): Promise<string | undefined> {
  try {
    const { gitDir, head } = await readGitDirectoryHead(gitRoot);
    if (!head) return undefined;
    const commonDir = await resolveGitCommonDirectory(gitDir);
    const parts = [gitDir, head];
    const refName = head.startsWith(GIT_SYMBOLIC_REF_PREFIX)
      ? head.slice(GIT_SYMBOLIC_REF_PREFIX.length).trim()
      : undefined;
    if (refName !== undefined) {
      // HEAD 来自仓库内容，拒绝带 `..` 或绝对路径的引用名，避免读到仓库外的文件。
      if (!refName.startsWith("refs/") || refName.split("/").includes("..")) return undefined;
      parts.push(await readOptionalText(join(commonDir, ...refName.split("/"))));
    }
    parts.push(
      await readStatToken(join(commonDir, "packed-refs")),
      await readStatToken(join(gitDir, "index")),
      await readStatToken(join(commonDir, "config")),
    );
    return parts.join("\0");
  } catch {
    return undefined;
  }
}

/** 先按目录读 `.git/HEAD`；读不到再把 `.git` 当作 worktree / submodule 的 `gitdir:` 文件。 */
async function readGitDirectoryHead(gitRoot: string): Promise<{ gitDir: string; head: string }> {
  const entry = join(gitRoot, GIT_DIRECTORY_ENTRY);
  const directHead = await readOptionalText(join(entry, "HEAD"));
  if (directHead) return { gitDir: entry, head: directHead };
  const contents = (await readFile(entry, "utf8")).trim();
  if (!contents.startsWith(GIT_DIR_FILE_PREFIX)) throw new Error("Unsupported .git entry");
  const target = contents.slice(GIT_DIR_FILE_PREFIX.length).trim();
  const gitDir = isAbsolute(target) ? target : resolve(gitRoot, target);
  return { gitDir, head: await readOptionalText(join(gitDir, "HEAD")) };
}

async function resolveGitCommonDirectory(gitDir: string): Promise<string> {
  const commonDir = await readOptionalText(join(gitDir, "commondir"));
  if (!commonDir) return gitDir;
  return isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir);
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

async function readStatToken(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function rememberHeadSnapshot(
  gitRoot: string,
  revision: string,
  snapshot: HeadDerivedGitSnapshot,
): void {
  headSnapshotCache.delete(gitRoot);
  headSnapshotCache.set(gitRoot, { revision, snapshot });
  while (headSnapshotCache.size > MAX_HEAD_SNAPSHOT_CACHE_ENTRIES) {
    const oldest = headSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    headSnapshotCache.delete(oldest);
  }
}

async function hasGitEntry(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, GIT_DIRECTORY_ENTRY));
    return true;
  } catch {
    return false;
  }
}

/** 只在 status 失败时使用：与原先独立读取分支名的命令一致。 */
async function resolveGitBranch(
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  // 修复原因：无提交时 rev-parse --abbrev-ref HEAD 以 128 退出，分支名丢失为 HEAD。
  // symbolic-ref 只读符号引用，不要求有提交；detached 时没有符号引用，仍退回 HEAD。
  const branch = await readTrimmedGitOutput([...GIT_CURRENT_BRANCH_ARGS], workingDirectory, signal);
  return branch || DETACHED_HEAD_BRANCH;
}

async function readTrimmedGitOutput(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const output = await readGitOutput(args, workingDirectory, signal);
  const trimmed = output?.trim();
  return trimmed ? trimmed : undefined;
}

async function readGitOutput(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await execGitNoThrow(args, workingDirectory, signal);
  return result.stdout;
}

// 找到的 git 在进程内复用；没找到不记住，装好 git 后下一次读取就能用上。
let gitExecutable: Promise<string | undefined> | undefined;

function resolveGitExecutable(): Promise<string | undefined> {
  // 查找不会失败：唯一会抛错的进程目录读取只在相对条目上发生，读不到就跳过该条目。
  gitExecutable ??= findExecutableOnPath(GIT_COMMAND, process.env).then((found) => {
    if (found === undefined) gitExecutable = undefined;
    return found;
  });
  return gitExecutable;
}

async function execGitNoThrow(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<GitCommandResult> {
  const executable = await resolveGitExecutable();
  // 没找到 git 与 git 无法启动相同：没有退出码，输出为空。
  if (executable === undefined) return { code: undefined, stderr: "", stdout: "" };
  try {
    // 修复原因：自动 git 不是工具调用，不经过权限判定。原来按裸名执行并继承全部环境，Windows 会运行
    // 工作区里的 git.exe；仓库配置的 fsmonitor、hooks 等会被执行；继承的 GIT_DIR 会让快照读另一个
    // 仓库。现在用 PATH 上的绝对路径，每条命令带固定的配置覆盖和环境。
    const result = await execFile(executable, automaticGitArgs(args), {
      cwd: workingDirectory,
      encoding: "utf8",
      env: automaticGitEnv(process.env),
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER_BYTES,
      // 请求取消时 git 立即结束，不必等到 3 秒超时。
      signal,
      timeout: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      code: 0,
      stderr: outputToString(result.stderr),
      stdout: outputToString(result.stdout),
    };
  } catch (error) {
    const failure = error as ExecFileFailure;
    return {
      code: typeof failure.code === "number" ? failure.code : undefined,
      // 命令失败时丢弃 stdout/stderr，避免把不可靠的错误输出写入 provider-visible git context。
      stderr: "",
      stdout: "",
    };
  }
}

// 自动 git 的加固：git 按 PATH 找绝对路径执行，每条命令带同一组配置覆盖与环境。
// 规则见 docs/design/v2/loop/meta-user-context.md 的 Git snapshot 一节。

const GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;

const GIT_CONTEXT_ENV = {
  GIT_ALLOW_PROTOCOL: "/",
  GIT_CONFIG_PARAMETERS: [
    "'alias.remote-none=version'",
    "'alias.remote-none.command=version'",
    "'alias.remote-/.command=version'",
    "'fetch.bundleURI='",
    "'help.autocorrect=0'",
  ].join(" "),
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_SSH_COMMAND: "false",
} as const;

// 继承来的这些变量会让 git 读另一个仓库、另一份配置；不分大小写去掉。
const INHERITED_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
  "GIT_NAMESPACE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_REFERENCE_BACKEND",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG",
]);
const INHERITED_GIT_CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i;
const POSIX_NULL_DEVICE = "/dev/null";
const WINDOWS_NULL_DEVICE = "\\\\.\\NUL";
// 与 Node 按裸名启动时相同：每个目录先试 .com 再试 .exe，不看 PATHEXT；.cmd / .bat 不经 shell 不能启动。
const WINDOWS_SPAWNABLE_EXTENSIONS = [".com", ".exe"] as const;

interface AutomaticGitConfig {
  /** 加在命令前的 `-c` 参数。 */
  args: readonly string[];
  /** 同一组配置的 GIT_CONFIG_COUNT / KEY / VALUE 镜像。 */
  env: Readonly<Record<string, string>>;
}

// 配置覆盖只与平台有关，每个平台只构建一次，不必每条命令重建两遍。
const automaticGitConfigs = new Map<NodeJS.Platform, AutomaticGitConfig>();

function automaticGitConfig(platform: NodeJS.Platform): AutomaticGitConfig {
  const cached = automaticGitConfigs.get(platform);
  if (cached) return cached;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["core.fsmonitor", ""],
    ["core.hooksPath", nullDevice(platform)],
    ["core.askPass", ""],
    ["protocol.ext.allow", "never"],
    ["submodule.recurse", "false"],
    ["log.showSignature", "false"],
    ["format.pretty", "medium"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ...GIT_HOOK_NAMES.map((hook) => [`hook.${hook}.enabled`, "false"] as const),
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const config = { args: pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]), env };
  automaticGitConfigs.set(platform, config);
  return config;
}

function nullDevice(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_NULL_DEVICE : POSIX_NULL_DEVICE;
}

/** 自动 git 命令的完整参数：配置覆盖在前，命令在后。 */
function automaticGitArgs(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...automaticGitConfig(platform).args, ...args];
}

/** 自动 git 命令的环境：去掉继承的仓库与配置选择变量，加上固定的安全变量和配置镜像。 */
export function automaticGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const mirrored = automaticGitConfig(platform).env;
  const setKeys = new Set([...Object.keys(GIT_CONTEXT_ENV), ...Object.keys(mirrored)]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const upper = key.toUpperCase();
    // 大小写不同的同名变量也去掉，Windows 上它们是同一个变量。
    const replaced = setKeys.has(upper) && key !== upper;
    if (INHERITED_GIT_ENV.has(upper) || INHERITED_GIT_CONFIG_ENTRY.test(key) || replaced) continue;
    env[key] = value;
  }
  Object.assign(env, GIT_CONTEXT_ENV, mirrored);
  env.GIT_PROXY_COMMAND = baseEnv.GIT_PROXY_COMMAND ?? "";
  // Windows 上变量名不分大小写；其他系统只处理名为 PATH 的变量。
  for (const key of Object.keys(env)) {
    const isPath = platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";
    const value = env[key];
    if (isPath && value !== undefined) env[key] = absolutePathEntries(value, platform);
  }
  return env;
}

/**
 * PATH 只留绝对路径条目，git 不会从工作目录启动外部程序；一个都不剩时用空设备。
 * 修复原因：原来不分平台按 ":" 拆、只留 "/" 开头。桌面 host 在 Windows 上以大写 PATH 启动 Agent，
 * Windows 条目被全部丢掉，git 找不到 git-lfs 等外部程序，LFS 仓库的 status 失败，快照显示干净。
 */
function absolutePathEntries(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const entries = platform === "win32" ? splitWindowsPath(value) : value.split(posix.delimiter);
  const kept = entries.filter((entry) => isFullPathEntry(entry, platform));
  return kept.length > 0 ? kept.join(pathApi.delimiter) : nullDevice(platform);
}

/** 不依赖进程目录的 PATH 条目。Windows 只认盘符或 UNC 开头；`\dir` 按当前盘符解析，它的 root 只有一个字符。 */
function isFullPathEntry(entry: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? win32.isAbsolute(entry) && win32.parse(entry).root.length > 1
    : posix.isAbsolute(entry);
}

export interface ExecutableLookupOptions {
  /** 相对 PATH 条目的基准目录，默认进程目录。 */
  cwd?: string;
  platform?: NodeJS.Platform;
  isExecutableFile?: (path: string) => Promise<boolean>;
}

/**
 * 按 PATH 查找可执行文件，返回绝对路径；找不到返回 undefined。
 * 修复原因：裸名交给 execFile 时，Windows 先在 cwd 里找（libuv search_path），工作区里放一个
 * git.exe 就会被自动 git 运行。这里只查 PATH 条目，不加工作目录。
 */
export async function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  options: ExecutableLookupOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile(platform);
  const directories =
    platform === "win32"
      ? splitWindowsPath(getWindowsEnvValue(env, "PATH") ?? "")
      : (env.PATH ?? "").split(posix.delimiter).filter((entry) => entry.length > 0);
  const fileNames =
    platform === "win32"
      ? WINDOWS_SPAWNABLE_EXTENSIONS.map((extension) => name + extension)
      : [name];
  for (const directory of directories) {
    // 修复原因：原来查找前先读进程目录，目录被删除时 process.cwd() 抛错，PATH 上绝对路径的 git
    // 也找不到。现在只有相对条目才读进程目录，读不到就跳过这个条目。
    const base = isFullPathEntry(directory, platform)
      ? directory
      : resolveRelativeEntry(directory, options.cwd, pathApi);
    if (base === undefined) continue;
    for (const fileName of fileNames) {
      const candidate = pathApi.join(base, fileName);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveRelativeEntry(
  entry: string,
  cwd: string | undefined,
  pathApi: typeof posix,
): string | undefined {
  try {
    return pathApi.resolve(cwd ?? process.cwd(), entry);
  } catch {
    return undefined;
  }
}

function defaultIsExecutableFile(platform: NodeJS.Platform): (path: string) => Promise<boolean> {
  return async (path) => {
    try {
      if (!(await stat(path)).isFile()) return false;
      if (platform !== "win32") await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function outputToString(output: Buffer | string | undefined): string {
  if (typeof output === "string") {
    return output;
  }
  return output?.toString("utf8") ?? "";
}

function splitGitStatusForContext(status: string): string[] {
  if (status.length === 0) {
    return [];
  }

  const boundedStatus =
    status.length > MAX_GIT_STATUS_CONTEXT_CHARS
      ? `${status.substring(0, MAX_GIT_STATUS_CONTEXT_CHARS)}
... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${gitStatusToolName()})`
      : status;

  // 与上游 CLI 保持一致：git status 只按 2k 字符截断，不按文件条目数截断，避免 provider-visible prompt 形状漂移。
  return boundedStatus.split(/\r?\n/u).filter((line) => line.length > 0);
}

function gitStatusToolName(): "Bash" | "PowerShell" {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
