import { describe, expect, it, vi } from "vitest";
import {
  acquireGitAutoRefreshScheduler,
  buildGitAutoRefreshWatchPaths,
  classifyGitAutoRefreshChange,
  GitAutoRefreshScheduler,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  stringifyGitAutoRefreshWatchPaths,
} from "@/lib/gitAutoRefresh.js";

describe("buildGitAutoRefreshWatchPaths", () => {
  it("does not watch stale Git state after switching workspace identity", () => {
    expect(
      shouldEnableGitAutoRefreshForWorkspace({
        enabled: true,
        currentWorkspaceKey: "remote:ssh:root@server-b:/root",
        summaryWorkspaceKey: "remote:ssh:root@server-a:/root",
      }),
    ).toBe(false);
    expect(
      shouldEnableGitAutoRefreshForWorkspace({
        enabled: true,
        currentWorkspaceKey: "remote:ssh:root@server-b:/root",
        summaryWorkspaceKey: "remote:ssh:root@server-b:/root",
      }),
    ).toBe(true);
  });

  it("keeps the recursive workspace watcher on non-Linux platforms", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/repo",
          repoRoot: "/repo",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: true }],
        },
        { platform: "darwin" },
      ),
    ).toEqual([
      {
        path: "/repo",
        recursive: true,
      },
      {
        path: "/repo/.git",
        recursive: true,
      },
    ]);
  });

  it("watches only Git metadata paths on Linux", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/home/user",
          repoRoot: "/home/user",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [
            { path: "/home/user", recursive: true },
            { path: "/home/user/.git", recursive: true },
          ],
        },
        { platform: "linux" },
      ),
    ).toEqual([
      {
        path: "/home/user/.git",
        recursive: true,
      },
    ]);
  });

  it("keeps the conservative metadata-only policy before the workspace Host platform is known", () => {
    expect(
      buildGitAutoRefreshWatchPaths({
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [
          { path: "/repo", recursive: true },
          { path: "/repo/.git", recursive: true },
        ],
      }),
    ).toEqual([
      {
        path: "/repo/.git",
        recursive: true,
      },
    ]);
  });

  it("does not reintroduce a legacy workspace path from an old server summary on Linux", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/repo",
          repoRoot: "/repo",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [
            { path: "/repo/", recursive: true },
            { path: "/repo/.git", recursive: true },
          ],
        },
        { platform: "linux" },
      ),
    ).toEqual([
      {
        path: "/repo/.git",
        recursive: true,
      },
    ]);
  });

  it("also watches Git metadata paths returned by the repository summary", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/worktree",
          repoRoot: "/worktree",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [
            { path: "/main/.git/worktrees/worktree", recursive: true },
            { path: "/main/.git", recursive: true },
          ],
        },
        { platform: "win32" },
      ),
    ).toEqual([
      {
        path: "/worktree",
        recursive: true,
      },
      {
        path: "/main/.git/worktrees/worktree",
        recursive: true,
      },
      {
        path: "/main/.git",
        recursive: true,
      },
    ]);
  });

  it("does not watch when git is unavailable or the workspace is not a repository", () => {
    expect(
      buildGitAutoRefreshWatchPaths({
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: false,
        isRepository: true,
      }),
    ).toEqual([]);

    expect(
      buildGitAutoRefreshWatchPaths({
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: false,
      }),
    ).toEqual([]);
  });

  it("keeps the same signature for equivalent watch paths", () => {
    const first = buildGitAutoRefreshWatchPaths(
      {
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: true }],
      },
      { platform: "linux" },
    );
    const second = buildGitAutoRefreshWatchPaths(
      {
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [{ path: "/repo/.git/", recursive: true }],
      },
      { platform: "linux" },
    );

    const signature = stringifyGitAutoRefreshWatchPaths(first);

    expect(stringifyGitAutoRefreshWatchPaths(second)).toBe(signature);
    expect(parseGitAutoRefreshWatchPaths(signature)).toEqual(first);
  });
});

describe("classifyGitAutoRefreshChange", () => {
  const context = { gitDirs: ["/repo/.git"], workspacePath: "/repo" };

  it("只保留 HEAD、index、refs 等影响状态的 gitdir 路径", () => {
    for (const path of [
      "/repo/.git/HEAD",
      "/repo/.git/index",
      "/repo/.git/packed-refs",
      "/repo/.git/refs/heads/main",
      "/repo/.git/MERGE_HEAD",
      "/repo/.git/rebase-merge/done",
      "/repo/.git/info/exclude",
    ])
      expect(classifyGitAutoRefreshChange(path, context)).toBe("refresh");
  });

  it("忽略 git status 自身的 index.lock、对象库、日志与 FETCH_HEAD 等噪声", () => {
    for (const path of [
      "/repo/.git",
      "/repo/.git/index.lock",
      "/repo/.git/refs/heads/main.lock",
      "/repo/.git/objects/ab/cdef",
      "/repo/.git/logs/HEAD",
      "/repo/.git/FETCH_HEAD",
      "/repo/.git/ORIG_HEAD",
      "/repo/.git/worktrees/feature/index",
    ])
      expect(classifyGitAutoRefreshChange(path, context)).toBe("ignore");
  });

  it("linked worktree 的 gitdir 优先于 common-dir 匹配", () => {
    const worktree = {
      gitDirs: ["/main/.git", "/main/.git/worktrees/feature"],
      workspacePath: "/feature",
    };
    expect(classifyGitAutoRefreshChange("/main/.git/worktrees/feature/index", worktree)).toBe(
      "refresh",
    );
    expect(classifyGitAutoRefreshChange("/main/.git/worktrees/other/index", worktree)).toBe(
      "ignore",
    );
  });

  it("Windows 路径按分隔符与盘符大小写归一后匹配 gitdir", () => {
    const windows = { gitDirs: ["C:/github/ZCode/.git"], workspacePath: "C:\\github\\ZCode" };
    expect(classifyGitAutoRefreshChange("c:\\github\\ZCode\\.git\\index.lock", windows)).toBe(
      "ignore",
    );
    expect(classifyGitAutoRefreshChange("C:\\github\\ZCode\\.git\\HEAD", windows)).toBe("refresh");
    expect(classifyGitAutoRefreshChange("C:\\github\\ZCode", windows)).toBe("refresh");
    expect(classifyGitAutoRefreshChange("C:\\github\\ZCode\\src\\a.ts", windows)).toBe("worktree");
  });

  it("没有具体路径时保守刷新；未知 gitdir 时按 .git 目录名兜底", () => {
    expect(classifyGitAutoRefreshChange(undefined, context)).toBe("refresh");
    expect(classifyGitAutoRefreshChange("/repo/.git/index.lock", { gitDirs: [] })).toBe("ignore");
    expect(classifyGitAutoRefreshChange("/repo/.git/HEAD", { gitDirs: [] })).toBe("refresh");
  });
});

describe("GitAutoRefreshScheduler", () => {
  function createScheduler(options?: { hidden?: boolean; ignored?: string[] }) {
    let hidden = options?.hidden ?? false;
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const checkIgnored = vi.fn(async (paths: string[]) =>
      paths.filter((path) => (options?.ignored ?? []).includes(path)),
    );
    const scheduler = new GitAutoRefreshScheduler({
      workspacePath: "/repo",
      isDocumentHidden: () => hidden,
      setTimer: (callback) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      },
      clearTimer: (handle) => timers.delete(handle as number),
    });
    scheduler.configure({ gitDirs: ["/repo/.git"], checkIgnored });
    const refreshed = vi.fn();
    scheduler.subscribe(refreshed);
    const settle = async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };
    return {
      scheduler,
      refreshed,
      checkIgnored,
      timers,
      settle,
      setHidden(value: boolean) {
        hidden = value;
        scheduler.handleVisibilityChange();
      },
      async fireTimer() {
        const pending = [...timers.values()];
        timers.clear();
        for (const callback of pending) callback();
        await settle();
      },
    };
  }

  it("gitdir 噪声不启动防抖计时器，状态文件变化在计时到期后刷新一次", async () => {
    const harness = createScheduler();
    harness.scheduler.notifyChange("/repo/.git/index.lock");
    harness.scheduler.notifyChange("/repo/.git/objects/ab/cd");
    expect(harness.timers.size).toBe(0);
    harness.scheduler.notifyChange("/repo/.git/HEAD");
    harness.scheduler.notifyChange("/repo/.git/refs/heads/main");
    expect(harness.timers.size).toBe(1);
    await harness.fireTimer();
    expect(harness.refreshed).toHaveBeenCalledTimes(1);
    expect(harness.checkIgnored).not.toHaveBeenCalled();
  });

  it("只有 ignored 工作树路径时一次判定后跳过刷新，并缓存 ignored 祖先", async () => {
    const harness = createScheduler({ ignored: ["/repo/node_modules"] });
    harness.scheduler.notifyChange("/repo/node_modules/pkg/index.js");
    await harness.fireTimer();
    expect(harness.checkIgnored).toHaveBeenCalledTimes(1);
    expect(harness.checkIgnored.mock.calls[0]?.[0]).toEqual([
      "/repo/node_modules",
      "/repo/node_modules/pkg",
      "/repo/node_modules/pkg/index.js",
    ]);
    expect(harness.refreshed).not.toHaveBeenCalled();
    // 已知 ignored 的子树后续事件直接丢弃，不再启动计时器或判定。
    harness.scheduler.notifyChange("/repo/node_modules/other/file.js");
    expect(harness.timers.size).toBe(0);
  });

  it("未忽略的工作树路径刷新一次，之后同一路径不再重复判定", async () => {
    const harness = createScheduler({ ignored: ["/repo/dist"] });
    harness.scheduler.notifyChange("/repo/src/a.ts");
    harness.scheduler.notifyChange("/repo/dist/a.js");
    await harness.fireTimer();
    expect(harness.refreshed).toHaveBeenCalledTimes(1);
    harness.scheduler.notifyChange("/repo/src/a.ts");
    await harness.fireTimer();
    expect(harness.checkIgnored).toHaveBeenCalledTimes(1);
    expect(harness.refreshed).toHaveBeenCalledTimes(2);
  });

  it(".gitignore 变化清空判定缓存并刷新", async () => {
    const harness = createScheduler({ ignored: ["/repo/dist"] });
    harness.scheduler.notifyChange("/repo/dist/a.js");
    await harness.fireTimer();
    expect(harness.refreshed).not.toHaveBeenCalled();
    harness.scheduler.notifyChange("/repo/.gitignore");
    await harness.fireTimer();
    expect(harness.refreshed).toHaveBeenCalledTimes(1);
    harness.scheduler.notifyChange("/repo/dist/a.js");
    expect(harness.timers.size).toBe(1);
  });

  it("窗口隐藏时不计时不刷新，回到前台立即补刷一次；无变化则不刷新", async () => {
    const harness = createScheduler({ hidden: true });
    harness.scheduler.notifyChange("/repo/.git/HEAD");
    harness.scheduler.notifyChange("/repo/.git/index");
    expect(harness.timers.size).toBe(0);
    expect(harness.refreshed).not.toHaveBeenCalled();
    harness.setHidden(false);
    await harness.settle();
    expect(harness.refreshed).toHaveBeenCalledTimes(1);
    harness.setHidden(true);
    harness.setHidden(false);
    await harness.settle();
    expect(harness.refreshed).toHaveBeenCalledTimes(1);
  });

  it("计时中被隐藏会停表，回到前台再刷新", async () => {
    const harness = createScheduler();
    harness.scheduler.notifyChange("/repo/.git/HEAD");
    expect(harness.timers.size).toBe(1);
    harness.setHidden(true);
    expect(harness.timers.size).toBe(0);
    harness.setHidden(false);
    await harness.settle();
    expect(harness.refreshed).toHaveBeenCalledTimes(1);
  });

  it("同一 workspace 的多个使用方共享一个节流所有者，最后释放时停表", () => {
    const key = { workspaceKey: "/shared", workspacePath: "/shared" };
    const first = acquireGitAutoRefreshScheduler(key);
    const second = acquireGitAutoRefreshScheduler(key);
    expect(second.scheduler).toBe(first.scheduler);
    first.release();
    first.release();
    const third = acquireGitAutoRefreshScheduler(key);
    expect(third.scheduler).toBe(first.scheduler);
    second.release();
    third.release();
    const fresh = acquireGitAutoRefreshScheduler(key);
    expect(fresh.scheduler).not.toBe(first.scheduler);
    fresh.release();
  });
});
