import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getTaskMeta } from "@/store/zcodeSessionStoreSelectors.js";
import { workbenchWorkspaceKey, type WorkbenchTab } from "@/v4/workbench-tabs/index.js";

/** 工作台只读标题投影；目录和会话元数据仍由原 owner 持有。 */
export function useWorkbenchSessionTitle(tab: WorkbenchTab): string {
  const { intl } = useZCodeIntl();
  const directory = useOptionalProjectDirectory();
  const workspaceKey = workbenchWorkspaceKey(tab.workspaceScope);
  const workspace = useZCodeSessionStore((state) => state.workspaces[workspaceKey]);
  const cached = workspace && tab.sessionId ? getTaskMeta(workspace, tab.sessionId) : undefined;
  const fact = tab.sessionId
    ? directory?.factTree.tasks.find(
        (task) =>
          task.taskId === tab.sessionId &&
          (task.workspaceIdentity?.trim() || task.workspacePath) === workspaceKey,
      )
    : undefined;
  // 原因：非空旧缓存曾永久盖住更新后的目录标题，菜单缺缓存时还显示截短 ID。
  // 复用既有修订/手动标题/占位防降级合同，不能在两个入口各自决定权威或写回缓存。
  const title = mergeTaskMetaCandidates(cached, fact)?.title;
  return title?.trim() && title.trim().toLocaleLowerCase() !== "new session"
    ? title
    : intl.formatMessage({ id: "workbench.newConversation" });
}
