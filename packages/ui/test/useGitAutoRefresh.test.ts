// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fileWatcherService, systemService } = vi.hoisted(() => ({
  fileWatcherService: {
    watch: vi.fn(async () => ({ id: "watch-1" })),
    unwatch: vi.fn(async () => {}),
    disposeAll: vi.fn(),
    onDynamicChange: vi.fn(() => () => ({ dispose: vi.fn() })),
  },
  systemService: {
    info: vi.fn(async () => ({ homedir: "/home/tester", platform: "linux" })),
  },
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({ fileWatcherService, systemService }),
}));

import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";

describe("useGitAutoRefresh", () => {
  beforeEach(() => {
    fileWatcherService.watch.mockClear();
    fileWatcherService.unwatch.mockClear();
    fileWatcherService.onDynamicChange.mockClear();
    systemService.info.mockClear();
  });

  it("uses the workspace Host platform and never recursively watches a Linux workspace root", async () => {
    renderHook(() =>
      useGitAutoRefresh({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:linux:/repo",
        remoteSessionId: "remote-session-1",
        gitSummary: {
          workspacePath: "/repo",
          repoRoot: "/repo",
          workspaceInRepoPath: ".",
          autoRefreshWatchPaths: [
            { path: "/repo", recursive: true },
            { path: "/repo/.git", recursive: true },
          ],
          branchName: "main",
          trackingBranchName: null,
          headRefType: "branch",
          ahead: 0,
          behind: 0,
          isDirty: false,
          isGitAvailable: true,
          isRepository: true,
        },
        gitSummaryWorkspaceKey: "remote:ssh:linux:/repo",
        enabled: true,
        onRefreshGit: vi.fn(),
      }),
    );

    await waitFor(() => expect(fileWatcherService.watch).toHaveBeenCalledTimes(1));
    expect(fileWatcherService.watch).toHaveBeenCalledWith({
      path: "/repo/.git",
      recursive: true,
    });
    expect(systemService.info).toHaveBeenCalledTimes(1);
  });

  describe("刷新节流（P8）", () => {
    const summary = {
      workspacePath: "/repo",
      repoRoot: "/repo",
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: true }],
      branchName: "main",
      trackingBranchName: null,
      headRefType: "branch" as const,
      ahead: 0,
      behind: 0,
      isDirty: false,
      isGitAvailable: true,
      isRepository: true,
    };
    let visibility: DocumentVisibilityState = "visible";

    async function renderWatchedHook(workspacePath: string) {
      const listeners: Array<(event: { dirPath: string; changedPath?: string }) => void> = [];
      fileWatcherService.onDynamicChange.mockImplementation(
        () => (listener: (event: { dirPath: string; changedPath?: string }) => void) => {
          listeners.push(listener);
          return { dispose: vi.fn() };
        },
      );
      const onRefreshGit = vi.fn();
      const hook = renderHook(() =>
        useGitAutoRefresh({
          workspacePath,
          gitSummary: {
            ...summary,
            workspacePath,
            repoRoot: workspacePath,
            autoRefreshWatchPaths: [{ path: `${workspacePath}/.git`, recursive: true }],
          },
          gitSummaryWorkspaceKey: workspacePath,
          enabled: true,
          onRefreshGit,
        }),
      );
      await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
      const fire = (changedPath?: string) => {
        for (const listener of listeners)
          listener({ dirPath: `${workspacePath}/.git`, ...(changedPath ? { changedPath } : {}) });
      };
      return { hook, fire, onRefreshGit };
    }

    beforeEach(() => {
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
    });

    it("git status 自身的 index.lock 事件不触发下一轮刷新（自激循环）", async () => {
      const { hook, fire, onRefreshGit } = await renderWatchedHook("/loop-repo");
      vi.useFakeTimers();
      try {
        fire("/loop-repo/.git/index.lock");
        fire("/loop-repo/.git/objects/ab/cd");
        vi.advanceTimersByTime(61_000);
        expect(onRefreshGit).not.toHaveBeenCalled();
        fire("/loop-repo/.git/HEAD");
        vi.advanceTimersByTime(59_000);
        expect(onRefreshGit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2_000);
        expect(onRefreshGit).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        hook.unmount();
      }
    });

    it("窗口隐藏时暂停自动刷新，回到前台立即补刷一次", async () => {
      const { hook, fire, onRefreshGit } = await renderWatchedHook("/hidden-repo");
      vi.useFakeTimers();
      try {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        fire("/hidden-repo/.git/HEAD");
        vi.advanceTimersByTime(10 * 60_000);
        expect(onRefreshGit).not.toHaveBeenCalled();
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(onRefreshGit).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        hook.unmount();
      }
    });
  });
});
