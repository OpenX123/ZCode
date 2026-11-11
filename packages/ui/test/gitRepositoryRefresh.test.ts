import { describe, expect, it } from "vitest";
import {
  buildRepositoryDatasets,
  shouldRefreshLiveGitData,
} from "../src/hooks/useGitRepository.js";

describe("shouldRefreshLiveGitData", () => {
  it("refreshes on initial load and workspace changes", () => {
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/repo-a",
        workspaceKey: "/repo-a",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: true,
      }),
    ).toBe(true);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-b",
          workspaceKey: "/repo-b",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("refreshes when the pane opens or user triggers an explicit refresh", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("refreshes when workspace identity changes even if the remote path is the same", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server-a:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server-b:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("does not refresh when only the pane closes or task-local data changes", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(false);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(false);
  });

  it("does not refresh disconnected remote placeholders until workspace RPC is available", () => {
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/root",
        workspaceKey: "remote:ssh:root@server:/root",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: false,
      }),
    ).toBe(false);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: false,
        },
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });
});

it("全部更改保留同文件的两个来源，文件数去重但行数累计", async () => {
  const { getGitDirtyFileCount } = await import("@/git-branch-switcher/display.js");
  const base = {
    path: "/repo/a.ts",
    repoRelativePath: "a.ts",
    workspaceRelativePath: "a.ts",
    kind: "modified" as const,
    isUntracked: false,
    isConflicted: false,
  };
  const datasets = buildRepositoryDatasets({
    unstagedChanges: [{ ...base, section: "unstaged", isStaged: false, added: 2, removed: 1 }],
    stagedChanges: [{ ...base, section: "staged", isStaged: true, added: 3, removed: 4 }],
    branchComparison: { baseRef: null, headRef: null, comparisonLabel: null, changes: [] },
  });
  expect(datasets.worktree.sections.map((s) => s.id)).toEqual(["unstaged", "staged"]);
  expect(getGitDirtyFileCount(datasets)).toBe(1);
  expect(
    datasets.worktree.sections.flatMap((s) => s.changes).map((f) => [f.added, f.removed]),
  ).toEqual([
    [2, 1],
    [3, 4],
  ]);
});

it("组合审阅对同路径暂存与未暂存请求分别读取真实来源", async () => {
  const { getGitPaneChangeSource, getDiffCacheKey } = await import("@/GitPane/helpers.js");
  expect(getGitPaneChangeSource("worktree", "staged")).toBe("staged");
  expect(getGitPaneChangeSource("worktree", "unstaged")).toBe("unstaged");
  expect(getGitPaneChangeSource("worktree", "untracked")).toBe("unstaged");
  expect(getDiffCacheKey("staged", "a.ts")).not.toBe(getDiffCacheKey("unstaged", "a.ts"));
});
