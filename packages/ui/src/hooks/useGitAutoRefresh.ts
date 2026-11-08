import { useEffect, useMemo, useRef, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { GitRepositorySummary } from "@zcode/shared";
import {
  acquireGitAutoRefreshScheduler,
  buildGitAutoRefreshWatchPaths,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  stringifyGitAutoRefreshWatchPaths,
  type GitAutoRefreshScheduler,
} from "@/lib/gitAutoRefresh.js";
import { logger } from "@/logger.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

interface GitWatcherRegistration {
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export function useGitAutoRefresh({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  gitSummary,
  gitSummaryWorkspaceKey,
  enabled,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  gitSummary: GitRepositorySummary;
  gitSummaryWorkspaceKey: string;
  enabled: boolean;
  onRefreshGit: () => void;
}) {
  const workspaceServices = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const { fileWatcherService, systemService, gitService } = workspaceServices;
  const refreshRef = useRef(onRefreshGit);
  const schedulerRef = useRef<GitAutoRefreshScheduler | null>(null);
  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const canWatchCurrentWorkspace = shouldEnableGitAutoRefreshForWorkspace({
    enabled,
    currentWorkspaceKey,
    summaryWorkspaceKey: gitSummaryWorkspaceKey,
  });
  const canAutoRefresh =
    canWatchCurrentWorkspace && gitSummary.isGitAvailable && gitSummary.isRepository;
  const [workspacePlatformState, setWorkspacePlatformState] = useState<{
    service: typeof systemService;
    platform: string;
  } | null>(null);
  // workspaceScopedServices 在远程 workspace 下指向远端 Host，因此这里获取的是
  // WSL/SSH/Docker 的真实运行平台，而不是桌面应用本身的平台。service identity
  // 参与状态匹配，避免 Windows workspace 的旧 platform 泄漏到刚切换的 Linux workspace。
  const workspacePlatform =
    workspacePlatformState?.service === systemService ? workspacePlatformState.platform : null;
  useEffect(() => {
    if (!canWatchCurrentWorkspace || !gitSummary.isGitAvailable || !gitSummary.isRepository) {
      return;
    }

    let cancelled = false;
    void systemService
      .info()
      .then((info) => {
        if (!cancelled) {
          setWorkspacePlatformState({ service: systemService, platform: info.platform });
        }
      })
      .catch(() => {
        // 平台信息不可用时由路径构造器采用 metadata-only 保守策略；手动刷新链路不受影响。
      });

    return () => {
      cancelled = true;
    };
  }, [canWatchCurrentWorkspace, gitSummary.isGitAvailable, gitSummary.isRepository, systemService]);
  const watchPathSignature = useMemo(
    () =>
      stringifyGitAutoRefreshWatchPaths(
        canWatchCurrentWorkspace
          ? buildGitAutoRefreshWatchPaths(
              gitSummary,
              workspacePlatform ? { platform: workspacePlatform } : null,
            )
          : [],
      ),
    [
      canWatchCurrentWorkspace,
      gitSummary.isGitAvailable,
      gitSummary.isRepository,
      gitSummary.repoRoot,
      gitSummary.workspacePath,
      gitSummary.autoRefreshWatchPaths,
      workspacePlatform,
    ],
  );
  const watchPaths = useMemo(
    () => parseGitAutoRefreshWatchPaths(watchPathSignature),
    [watchPathSignature],
  );
  // gitdir / common-dir 由 Git 自身解析（summary.autoRefreshWatchPaths）；旧 server 可能夹带
  // workspace 内容路径，不能把它当成 gitdir，否则整个工作树都会被当作 gitdir 噪声过滤。
  const gitDirsSignature = useMemo(
    () =>
      JSON.stringify(
        (gitSummary.autoRefreshWatchPaths ?? [])
          .map((watchPath) => watchPath.path)
          .filter((path) => path.trim() && path !== gitSummary.workspacePath),
      ),
    [gitSummary.autoRefreshWatchPaths, gitSummary.workspacePath],
  );

  refreshRef.current = onRefreshGit;

  // 节流所有者按 workspaceKey 共享（文件树 watcher 也报告到同一个），见 docs/ui/git-auto-refresh.md。
  useEffect(() => {
    if (!canAutoRefresh) return;
    const lease = acquireGitAutoRefreshScheduler({
      workspaceKey: currentWorkspaceKey,
      workspacePath,
    });
    lease.scheduler.configure({
      gitDirs: JSON.parse(gitDirsSignature) as string[],
      ...(gitService
        ? {
            checkIgnored: (paths: string[]) => gitService.getIgnoredPaths({ workspacePath, paths }),
          }
        : {}),
    });
    schedulerRef.current = lease.scheduler;
    const unsubscribe = lease.scheduler.subscribe(() => {
      logger.debug("[GitAutoRefresh] Git 状态变更，刷新仓库状态", { workspacePath });
      refreshRef.current();
    });
    return () => {
      unsubscribe();
      if (schedulerRef.current === lease.scheduler) schedulerRef.current = null;
      lease.release();
    };
  }, [canAutoRefresh, currentWorkspaceKey, gitDirsSignature, gitService, workspacePath]);

  useEffect(() => {
    let cancelled = false;
    const registrations: GitWatcherRegistration[] = [];

    // Git summary 每次刷新都会带回新的 autoRefreshWatchPaths 数组引用。
    // 监听路径内容没变时不能重建 watcher，否则 agent 批量写文件会出现 unwatch/watch 风暴。
    for (const watchPath of watchPaths) {
      void fileWatcherService
        .watch({
          path: watchPath.path,
          recursive: watchPath.recursive,
        })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            // 过滤、防抖与窗口可见性暂停都由节流所有者负责；这里只上报具体变化路径。
            schedulerRef.current?.notifyChange(event.changedPath);
          });
          registrations.push({
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          // Git 实时刷新只是加速 UI 状态同步；监听失败时保留原有手动刷新和操作后刷新链路。
          logger.warn("[GitAutoRefresh] 监听 Git 工作区失败", {
            workspacePath,
            path: watchPath.path,
            recursive: watchPath.recursive,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      cancelled = true;
      for (const registration of registrations) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[GitAutoRefresh] 停止监听 Git 工作区失败", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [fileWatcherService, watchPaths, workspacePath]);
}
