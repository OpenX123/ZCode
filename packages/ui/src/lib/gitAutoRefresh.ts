import type { GitRepositorySummary, SystemInfo } from "@zcode/shared";

export interface GitAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

export function shouldEnableGitAutoRefreshForWorkspace(params: {
  enabled: boolean;
  currentWorkspaceKey: string;
  summaryWorkspaceKey: string;
}): boolean {
  return params.enabled && params.currentWorkspaceKey === params.summaryWorkspaceKey;
}

function normalizeWatchPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

export function buildGitAutoRefreshWatchPaths(
  summary: Pick<
    GitRepositorySummary,
    "workspacePath" | "repoRoot" | "isGitAvailable" | "isRepository"
  > &
    Partial<Pick<GitRepositorySummary, "autoRefreshWatchPaths">>,
  systemInfo?: Pick<SystemInfo, "platform"> | null,
): GitAutoRefreshWatchPath[] {
  if (!summary.isGitAvailable || !summary.isRepository) {
    return [];
  }

  const workspacePath = normalizeWatchPath(summary.workspacePath || summary.repoRoot);
  const platform = systemInfo?.platform?.trim();
  const canWatchWorkspaceRecursively = Boolean(platform && platform !== "linux");
  const watchPaths: GitAutoRefreshWatchPath[] = [];
  if (workspacePath.length > 0 && canWatchWorkspaceRecursively) {
    watchPaths.push({
      path: workspacePath,
      recursive: true,
    });
  }

  for (const watchPath of summary.autoRefreshWatchPaths ?? []) {
    const path = normalizeWatchPath(watchPath.path);
    if (
      !path ||
      // 兼容旧 remote server：旧 summary 仍可能携带 workspacePath，Linux 下不能让
      // 这个历史字段重新绕过平台边界，触发慢速递归 watcher。
      (path === workspacePath && !canWatchWorkspaceRecursively) ||
      watchPaths.some((entry) => entry.path === path)
    ) {
      continue;
    }

    watchPaths.push({
      path,
      recursive: watchPath.recursive,
    });
  }

  return watchPaths;
}

export function stringifyGitAutoRefreshWatchPaths(
  watchPaths: readonly GitAutoRefreshWatchPath[],
): string {
  return JSON.stringify(watchPaths);
}

export function parseGitAutoRefreshWatchPaths(
  signature: string,
): GitAutoRefreshWatchPath[] {
  const parsed = JSON.parse(signature) as GitAutoRefreshWatchPath[];
  return parsed.map((watchPath) => ({
    path: watchPath.path,
    recursive: Boolean(watchPath.recursive),
  }));
}

/**
 * Git 自动刷新的防抖窗口。agent 批量写文件时，150ms watcher 防抖 + 350ms Git 防抖仍会把长批次
 * 拆成多轮 `git status`，因此统一延后到 1 分钟（规则见 docs/ui/git-auto-refresh.md）。
 */
export const GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000;
/** 单个防抖窗口内待判定 ignored 的工作树路径上限；超出直接保守刷新，避免无界积累。 */
const GIT_AUTO_REFRESH_MAX_PENDING_PATHS = 256;
/** 一次 ignored 判定（含祖先目录）最多提交的路径数；超出直接保守刷新。 */
const GIT_AUTO_REFRESH_MAX_IGNORE_QUERY_PATHS = 256;
/** ignored / 非 ignored 判定缓存上限；超出整体清空，下次按需重新判定。 */
const GIT_AUTO_REFRESH_MAX_CACHED_PATHS = 4096;

/** gitdir 内会改变 `git status` / 分支展示结果的文件（小写比较，兼容 Windows 归一化）。 */
const GIT_STATE_FILES = new Set([
  "head",
  "index",
  "packed-refs",
  "config",
  "info/exclude",
  "merge_head",
  "cherry_pick_head",
  "revert_head",
  "rebase_head",
]);
const GIT_STATE_DIRECTORIES = ["refs", "rebase-merge", "rebase-apply"];

export type GitAutoRefreshChangeKind = "ignore" | "refresh" | "worktree";

/** 统一分隔符与 Windows 盘符大小写，只用于比较，不回写给 Host。 */
function normalizeComparablePath(path: string): string {
  let value = path.trim().replace(/\\/g, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");
  if (/^[A-Za-z]:(\/|$)/.test(value) || value.startsWith("//")) value = value.toLowerCase();
  return value;
}

function isSameOrInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function isGitStateRelativePath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  // ref / index 写入先写 *.lock 再 rename；rename 会为目标文件单独产生事件，lock 本身只是噪声。
  if (lower.endsWith(".lock")) return false;
  if (GIT_STATE_FILES.has(lower)) return true;
  return GIT_STATE_DIRECTORIES.some(
    (directory) => lower === directory || lower.startsWith(`${directory}/`),
  );
}

/** 返回 gitdir 内的相对路径；null 表示 gitdir 目录自身，undefined 表示不在任何 gitdir 内。 */
function resolveGitDirRelativePath(
  path: string,
  gitDirs: readonly string[],
): string | null | undefined {
  // 先按 Git 自身解析出的 gitdir/common-dir 匹配（覆盖 linked worktree 与 separate git-dir），
  // 较长的路径优先：linked worktree 的 gitdir 位于 common-dir 的 worktrees/ 之下。
  const gitDir = gitDirs
    .map(normalizeComparablePath)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((dir) => isSameOrInside(path, dir));
  if (gitDir) return path === gitDir ? null : path.slice(gitDir.length + 1);
  // 只有文件树报告变化、尚未拿到 summary 时按 `.git` 目录名兜底。
  if (path.endsWith("/.git")) return null;
  const segment = path.lastIndexOf("/.git/");
  return segment >= 0 ? path.slice(segment + "/.git/".length) : undefined;
}

/**
 * 判定一次文件变化是否可能改变 Git 状态：
 * - `ignore`：gitdir 内部噪声（objects、logs、FETCH_HEAD、*.lock、gitdir 目录自身等）；
 * - `refresh`：HEAD/index/refs 等状态文件、workspace 根目录，或无法得知具体路径；
 * - `worktree`：工作树路径，是否刷新取决于它是否被 .gitignore 忽略。
 */
export function classifyGitAutoRefreshChange(
  changedPath: string | undefined,
  context: { gitDirs: readonly string[]; workspacePath?: string },
): GitAutoRefreshChangeKind {
  if (!changedPath?.trim()) return "refresh";
  const path = normalizeComparablePath(changedPath);
  const gitRelativePath = resolveGitDirRelativePath(path, context.gitDirs);
  if (gitRelativePath === null) return "ignore";
  if (gitRelativePath !== undefined)
    return isGitStateRelativePath(gitRelativePath) ? "refresh" : "ignore";
  if (context.workspacePath && path === normalizeComparablePath(context.workspacePath))
    return "refresh";
  return "worktree";
}

function isGitIgnoreRuleChange(changedPath: string, gitDirs: readonly string[]): boolean {
  const path = normalizeComparablePath(changedPath);
  if (path === ".gitignore" || path.endsWith("/.gitignore")) return true;
  return resolveGitDirRelativePath(path, gitDirs)?.toLowerCase() === "info/exclude";
}

/** 工作树路径自身及其位于 workspace 内的祖先目录（由浅到深，保留 Host 原始写法）。 */
function listWorkspaceAncestors(path: string, workspacePath: string | undefined): string[] {
  if (!workspacePath) return [path];
  const root = normalizeComparablePath(workspacePath);
  const chain: string[] = [];
  let current = path;
  while (current) {
    const comparable = normalizeComparablePath(current);
    if (comparable === root || !isSameOrInside(comparable, root)) break;
    chain.unshift(current);
    const separator = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
    if (separator <= 0) break;
    current = current.slice(0, separator);
  }
  return chain;
}

export interface GitAutoRefreshSchedulerOptions {
  workspacePath?: string;
  debounceMs?: number;
  /** 窗口可见性的唯一事实是 document.visibilityState；测试可注入。 */
  isDocumentHidden?: () => boolean;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface GitAutoRefreshSchedulerConfig {
  /** Git 自身解析出的 gitdir / common-dir（summary.autoRefreshWatchPaths）。 */
  gitDirs?: readonly string[];
  /** 返回输入中被 .gitignore 忽略的路径（原样字符串）。 */
  checkIgnored?: (paths: string[]) => Promise<string[]>;
}

function readDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 每个 workspace 唯一的 Git 自动刷新节流所有者：Git watcher 与文件树 watcher 只报告变化，
 * 由这里统一过滤噪声、做 1 分钟防抖、在窗口不可见时暂停，再通知所有刷新订阅者。
 */
export class GitAutoRefreshScheduler {
  private readonly listeners = new Set<() => void>();
  private readonly pendingWorktreePaths = new Map<string, string>();
  private readonly ignoredPaths = new Set<string>();
  private readonly notIgnoredPaths = new Set<string>();
  private pendingRefresh = false;
  private timer: unknown;
  private disposed = false;
  private gitDirs: readonly string[] = [];
  private checkIgnored?: (paths: string[]) => Promise<string[]>;
  private readonly debounceMs: number;
  private readonly isDocumentHidden: () => boolean;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: GitAutoRefreshSchedulerOptions = {}) {
    this.debounceMs = options.debounceMs ?? GIT_AUTO_REFRESH_DEBOUNCE_MS;
    this.isDocumentHidden = options.isDocumentHidden ?? readDocumentHidden;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  configure(config: GitAutoRefreshSchedulerConfig): void {
    if (config.gitDirs) this.gitDirs = config.gitDirs;
    if (config.checkIgnored) this.checkIgnored = config.checkIgnored;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyChange(changedPath?: string): void {
    if (this.disposed) return;
    let kind = classifyGitAutoRefreshChange(changedPath, {
      gitDirs: this.gitDirs,
      workspacePath: this.options.workspacePath,
    });
    // Bug 原因（P8）：`git status` 自身创建/删除 .git/index.lock，旧实现把它当成变化，
    // 每次刷新都在 60 秒后安排下一次（日志 60.48s 链）。gitdir 噪声在这里直接丢弃，不重置防抖。
    if (kind === "ignore") return;
    if (changedPath && isGitIgnoreRuleChange(changedPath, this.gitDirs)) {
      this.ignoredPaths.clear();
      this.notIgnoredPaths.clear();
      kind = "refresh";
    }
    if (kind === "worktree" && changedPath) {
      const comparable = normalizeComparablePath(changedPath);
      // 已知被 .gitignore 忽略的子树（node_modules、构建产物）不重置防抖。
      if (this.isKnownIgnored(comparable)) return;
      if (this.notIgnoredPaths.has(comparable)) kind = "refresh";
      else if (this.pendingWorktreePaths.size >= GIT_AUTO_REFRESH_MAX_PENDING_PATHS)
        kind = "refresh";
      else this.pendingWorktreePaths.set(comparable, changedPath);
    }
    if (kind === "refresh") this.pendingRefresh = true;
    this.arm();
  }

  /** visibilitychange 回调：隐藏时停表只累积，回到前台若有累积变化立即补刷一次。 */
  handleVisibilityChange(): void {
    if (this.disposed) return;
    this.cancelTimer();
    if (this.isDocumentHidden()) return;
    if (this.pendingRefresh || this.pendingWorktreePaths.size > 0) void this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
    this.pendingWorktreePaths.clear();
    this.pendingRefresh = false;
  }

  private arm(): void {
    this.cancelTimer();
    // 窗口隐藏/最小化时不启动计时器（P8：隐藏实例通宵刷新 136 次），回到前台再补刷。
    if (this.isDocumentHidden()) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private isKnownIgnored(comparablePath: string): boolean {
    for (const ignored of this.ignoredPaths)
      if (isSameOrInside(comparablePath, ignored)) return true;
    return false;
  }

  private remember(set: Set<string>, comparablePath: string): void {
    if (set.size >= GIT_AUTO_REFRESH_MAX_CACHED_PATHS) set.clear();
    set.add(comparablePath);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.isDocumentHidden()) return;
    const refresh = this.pendingRefresh;
    const worktreePaths = [...this.pendingWorktreePaths.values()];
    this.pendingRefresh = false;
    this.pendingWorktreePaths.clear();
    if (refresh || (worktreePaths.length > 0 && !this.checkIgnored)) {
      this.notify();
      return;
    }
    if (worktreePaths.length === 0) return;
    if (await this.areAllIgnored(worktreePaths)) return;
    if (!this.disposed) this.notify();
  }

  /** 一次 getIgnoredPaths 判定本窗口的未知工作树路径；判定失败按未忽略保守刷新。 */
  private async areAllIgnored(paths: string[]): Promise<boolean> {
    const chains = paths.map((path) => listWorkspaceAncestors(path, this.options.workspacePath));
    const query = [...new Set(chains.flat())];
    const checkIgnored = this.checkIgnored;
    if (!checkIgnored || query.length === 0) return false;
    if (query.length > GIT_AUTO_REFRESH_MAX_IGNORE_QUERY_PATHS) return false;
    let ignored: Set<string>;
    try {
      ignored = new Set((await checkIgnored(query)).map(normalizeComparablePath));
    } catch {
      return false;
    }
    let allIgnored = true;
    for (const chain of chains) {
      // 祖先目录被忽略时其下所有路径都被忽略；缓存最浅的 ignored 祖先，后续事件直接丢弃。
      const ignoredAncestor = chain
        .map(normalizeComparablePath)
        .find((comparable) => ignored.has(comparable));
      if (ignoredAncestor) {
        this.remember(this.ignoredPaths, ignoredAncestor);
        continue;
      }
      allIgnored = false;
      const leaf = chain[chain.length - 1];
      if (leaf) this.remember(this.notIgnoredPaths, normalizeComparablePath(leaf));
    }
    return allIgnored;
  }
}

interface GitAutoRefreshSchedulerEntry {
  scheduler: GitAutoRefreshScheduler;
  refCount: number;
  detachVisibility: () => void;
}

const gitAutoRefreshSchedulers = new Map<string, GitAutoRefreshSchedulerEntry>();

/**
 * 按 workspaceKey（`workspaceIdentity?.trim() || workspacePath`）共享节流所有者；
 * 最后一个使用方释放时停表并解除可见性监听。
 */
export function acquireGitAutoRefreshScheduler(params: {
  workspaceKey: string;
  workspacePath: string;
}): { scheduler: GitAutoRefreshScheduler; release: () => void } {
  let entry = gitAutoRefreshSchedulers.get(params.workspaceKey);
  if (!entry) {
    const scheduler = new GitAutoRefreshScheduler({ workspacePath: params.workspacePath });
    const onVisibilityChange = () => scheduler.handleVisibilityChange();
    const target =
      typeof document !== "undefined" && typeof document.addEventListener === "function"
        ? document
        : undefined;
    target?.addEventListener("visibilitychange", onVisibilityChange);
    entry = {
      scheduler,
      refCount: 0,
      detachVisibility: () => target?.removeEventListener("visibilitychange", onVisibilityChange),
    };
    gitAutoRefreshSchedulers.set(params.workspaceKey, entry);
  }
  entry.refCount += 1;
  const acquired = entry;
  let released = false;
  return {
    scheduler: acquired.scheduler,
    release: () => {
      if (released) return;
      released = true;
      acquired.refCount -= 1;
      if (acquired.refCount > 0) return;
      acquired.detachVisibility();
      acquired.scheduler.dispose();
      if (gitAutoRefreshSchedulers.get(params.workspaceKey) === acquired)
        gitAutoRefreshSchedulers.delete(params.workspaceKey);
    },
  };
}
