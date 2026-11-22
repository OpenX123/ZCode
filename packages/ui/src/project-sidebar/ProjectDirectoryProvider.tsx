import { useSourceServerDisplayNames } from "@/hooks/useSourceServerDisplayNames.js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  badgeViewedTaskKey,
  countProjectTreeBadgeTasks,
  reconcileBadgeWaitingAcknowledgements,
} from "@/project-sidebar/view.js";
import { useTaskNotificationPreferencesSnapshot } from "@/lib/taskNotificationPreferences.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import { useTaskGroups } from "@/project-sidebar/useTaskGroups.js";
import { selectSortedProjects } from "@/project-sidebar/view.js";
import {
  remoteHostIdFromWorkspaceIdentity,
  type ProjectTree,
  type VirtualProject,
} from "@/project-sidebar/contract.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorkbenchTabsStore, workbenchWorkspaceKey } from "@/v4/workbench-tabs/index.js";

function useDirectoryState(isDesktop: boolean) {
  const result = useProjectTree(isDesktop);
  // 手机有项目目录不代表拥有 Source 管理权限；名称注册表仅在桌面订阅，手机沿用 Host 目录标签。
  const deviceNames = useSourceServerDisplayNames(isDesktop);
  const groups = useTaskGroups(result.factTree);
  const sortedProjects = useMemo(
    () => selectSortedProjects(result.factTree),
    [result.factTree.projects],
  );
  const preferences = useProjectSidebarPreferences(
    sortedProjects,
    result.loading,
    result.availability,
  );
  const projects = useMemo(() => {
    const sorted = preferences.sort(sortedProjects);
    return [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)];
  }, [sortedProjects, preferences.order]);
  // Context 不受消费方 memo 保护；父级更新 children 时，等价目录不能再次广播。
  return useMemo(
    () => ({ ...result, preferences, projects, groups, deviceNames }),
    [result, preferences, projects, groups, deviceNames],
  );
}
const Context = createContext<ReturnType<typeof useDirectoryState> | null>(null);
/** 侧栏和 composer 共享读取与偏好，避免各自订阅后出现两份项目目录。 */
export function ProjectDirectoryProvider({
  children,
  isDesktop = false,
}: {
  children: ReactNode;
  isDesktop?: boolean;
}) {
  const existing = useContext(Context);
  return existing ? children : <DirectoryOwner isDesktop={isDesktop}>{children}</DirectoryOwner>;
}
function DirectoryOwner({ children, isDesktop }: { children: ReactNode; isDesktop: boolean }) {
  const directory = useDirectoryState(isDesktop);
  // 任务栏/托盘角标 = 未读已完成任务 ∪ 等待用户操作的任务（spec：
  // docs/desktop/windows-taskbar-unread-badge.md）。未读与侧栏蓝点同源（权威树）。
  // 挂在 Provider owner（Root 顶层，常驻不卸载）而不是 ProjectSidebar：侧栏卸载期间
  // 后台完成的未读变化也要同步到任务栏/托盘。嵌入 pane / 测试环境无 Provider 时跳过。
  const platform = useOptionalPlatform();
  // 任务通知开关同时门控任务栏/托盘角标：关掉通知 = 连常驻提醒一起关闭
  // （同步 0 清空角标），侧栏蓝点作为应用内状态不受影响。
  const notificationEnabled = useTaskNotificationPreferencesSnapshot().enabled;
  const acknowledgedWaiting = useBadgeWaitingAcknowledgements(directory.tree);
  const badgeTaskCount = useMemo(
    () => countProjectTreeBadgeTasks(directory.tree, acknowledgedWaiting),
    [directory.tree, acknowledgedWaiting],
  );
  useEffect(() => {
    platform?.syncWindowUnreadCount(notificationEnabled ? badgeTaskCount : 0);
  }, [platform, notificationEnabled, badgeTaskCount]);
  useReleaseDeletedProjectDrafts(directory.factTree.projects);
  return <Context.Provider value={directory}>{children}</Context.Provider>;
}
/** 窗口聚焦且可见：只有用户真正看着窗口时，激活 tab 上的等待态才算“已查看”。 */
function useWindowViewing(): boolean {
  const read = () =>
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus();
  const [viewing, setViewing] = useState(read);
  useEffect(() => {
    const sync = () => setViewing(read());
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return viewing;
}

/** 本窗口各分栏激活 tab 绑定的任务；以稳定字符串订阅，避免无关 tab 变化重算。 */
function useViewedTaskKeys(): ReadonlySet<string> {
  const serialized = useWorkbenchTabsStore((state) =>
    JSON.stringify(
      state.groups
        .map((group) => state.tabs[group.activeTabId])
        .flatMap((tab) =>
          tab?.sessionId
            ? [badgeViewedTaskKey(workbenchWorkspaceKey(tab.workspaceScope), tab.sessionId)]
            : [],
        )
        .sort(),
    ),
  );
  return useMemo(() => new Set(JSON.parse(serialized) as string[]), [serialized]);
}

/**
 * 等待态“打开即清除”：窗口被查看时，激活 tab 任务的当前等待签名记为已确认；
 * 等待签名变化（新的审批/提问）重新计入，等待结束后确认随之裁剪。
 * 确认是本窗口 UI 局部状态，不写回 Host，也不冒充服务端事实。
 */
function useBadgeWaitingAcknowledgements(tree: ProjectTree): ReadonlySet<string> {
  const viewing = useWindowViewing();
  const viewedTaskKeys = useViewedTaskKeys();
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setAcknowledged((previous) =>
      reconcileBadgeWaitingAcknowledgements({
        tree,
        previous,
        viewed: viewing ? viewedTaskKeys : new Set(),
      }),
    );
  }, [tree, viewing, viewedTaskKeys]);
  return acknowledged;
}

/**
 * 修复「连接引擎失败: project.deleted」：项目被删除后草稿仍保留其 ID，界面按过滤后的列表显示
 * “选择项目”，预热却带着已删 ID 调用 createSession。目录 owner 是唯一知道删除事实的常驻方，
 * 在此统一释放两类草稿归属，覆盖本窗口、其他窗口删除与本地残留草稿；只认 deleted 事实。
 */
function useReleaseDeletedProjectDrafts(projects: readonly VirtualProject[]) {
  const shouldRelease = useMemo(() => deletedProjectDraftMatcher(projects), [projects]);
  useEffect(() => {
    if (shouldRelease) releaseDeletedProjectDrafts(shouldRelease);
  }, [shouldRelease]);
}

/** 两类草稿归属的唯一释放路径；工作台复用 newDraft 原地改选，不新增布局命令。 */
export function releaseDeletedProjectDrafts(
  shouldRelease: (projectId: string, workspaceKey: string) => boolean,
) {
  const workbench = useWorkbenchTabsStore.getState();
  for (const tab of Object.values(workbench.tabs)) {
    if (tab.sessionId !== null || typeof tab.projectId !== "string") continue;
    if (!shouldRelease(tab.projectId, workbenchWorkspaceKey(tab.workspaceScope))) continue;
    // 分组隶属于项目，一并释放，否则首发仍落到已删项目的分组。
    workbench.newDraft(tab.workspaceScope, {
      replaceDraftTabId: tab.id,
      projectId: null,
      taskGroupId: null,
    });
  }
  useZCodeSessionStore.getState().releaseDraftProjects(shouldRelease);
}

/** 按 Host + project 精确匹配已删项目；本地工作区 key 不是远端 identity 时属于 local Host。 */
export function deletedProjectDraftMatcher(
  projects: readonly Pick<VirtualProject, "id" | "hostId" | "deleted">[],
): ((projectId: string, workspaceKey: string) => boolean) | null {
  const deleted = new Set(
    projects
      .filter((project) => project.deleted)
      .map((project) => JSON.stringify([project.hostId, project.id])),
  );
  if (!deleted.size) return null;
  return (projectId, workspaceKey) =>
    deleted.has(
      JSON.stringify([remoteHostIdFromWorkspaceIdentity(workspaceKey) ?? "local", projectId]),
    );
}

export function useProjectDirectory() {
  const directory = useContext(Context);
  if (!directory) throw new Error("project.directory-provider-required");
  return directory;
}

/** 嵌入式 pane 可无侧栏；完整 Shell 必须使用同一目录 owner。 */
export function useOptionalProjectDirectory() {
  return useContext(Context);
}
