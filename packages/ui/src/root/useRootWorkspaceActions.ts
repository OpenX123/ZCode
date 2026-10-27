import { readProjectSidebarView } from "@/project-sidebar/index.js";
import {
  captureV4ComposerDraftHandoff,
  stageV4ComposerDraftAttachments,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
/* eslint-disable max-lines -- Root workspace action hook 集中编排项目、远程和 conversation 入口；合并期保持动作边界完整，后续按领域拆分。 */
import type {
  CreateTaskOptions,
  CreateTaskRequest,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import type { WorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import { resolveWorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { parseWslUncWorkspacePath } from "@/lib/wslUncWorkspace.js";
import { logger } from "@/logger.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import type { RootProps } from "@/root/types.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { type TabStore, type TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { notifyTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import {
  bindPendingTaskDraft,
  ensurePendingTaskDraft,
  persistV4ComposerDraft,
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import {
  getFocusedWorkbenchTab,
  getWorkbenchDraftScopeId,
  useWorkbenchTabsStore,
} from "@/v4/workbench-tabs/index.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import type { IServiceAccessor } from "@zcode/services";
import {
  remoteHostIdFromWorkspaceIdentity,
  type IPlatformService,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
/** 新任务落点：identity 缺省一律归一化为 null，供只读校验、focus/addTab 统一消费。 */
export interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}
/**
 * 解析新任务落点：请求显式带 targetWorkspace 时（跨项目发起已保存工作流）直接采用它，不再询问 workbench 焦点；
 * 否则惰性回退到 resolveWorkbenchNewTaskTarget。identity 缺省归一化为 null。
 */
export function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}
export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  onOpenRemoteConnection,
  openRemoteProjectWorkspace,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  openRemoteProjectWorkspace?: (target: {
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    expectedMembershipId?: string;
    projectId: string | null;
    isCurrent?: () => boolean;
  }) => Promise<void>;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  const navigationSequence = useRef(0);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const requestConfirmation = useConfirmDialog();
  // Root 的远端装配依赖本 hook 返回的动作，函数引用每轮都会变化；它只用于点击执行，
  // 不应使整个新建入口失稳。与任务导航一致，读取最近已提交实现，并冻结本次操作的实现。
  const remoteProjectOpener = useRef(openRemoteProjectWorkspace);
  useLayoutEffect(() => {
    remoteProjectOpener.current = openRemoteProjectWorkspace;
  });
  useEffect(() => {
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    // 冷启动恢复布局是显式产品规则；旧布局由工作台一次性消费迁移，不能在这里提前清空。
  }, [workbenchGroupClientMode]);
  const composerClientNamespace = useComposerClientNamespace();
  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string, options?: CreateTaskOptions) => {
      const replaceId = options?.replaceDraftTabId;
      if (replaceId) {
        const workbench = useWorkbenchTabsStore.getState();
        const source = workbench.tabs[replaceId];
        if (!source || source.sessionId !== null) return;
        const handoff =
          options.initialComposerDraft ??
          captureV4ComposerDraftHandoff(
            source.workspaceScope.workspacePath,
            source.workspaceScope.workspaceIdentity,
            composerClientNamespace,
            getWorkbenchDraftScopeId(source.draftId ?? source.id),
          );
        const projectId = options.projectId ?? null;
        const taskGroupId =
          options.taskGroupId !== undefined ? options.taskGroupId : source.taskGroupId;
        const scope = resolveComposerScope(projectId, workspaceIdentity, composerClientNamespace);
        const draftScopeId = getWorkbenchDraftScopeId(source.draftId ?? source.id);
        // 先暂存精确草稿，再原子换目录；不重置同目录其他会话的 workspace 级导航。
        persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          draftScopeId,
          { ...handoff.draft, projectId, taskGroupId },
          scope,
        );
        stageV4ComposerDraftAttachments(workspacePath, workspaceIdentity, 0, handoff, draftScopeId);
        if (options.draftId)
          bindPendingTaskDraft({ ...scope, draftId: replaceId }, options.draftId, workspacePath);
        const workspaceTab = tabStoreApi
          .getState()
          .tabs.find(
            (tab) =>
              tab.kind === "workspace" &&
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
                (workspaceIdentity?.trim() || workspacePath),
          );
        workbench.newDraft(
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspaceTab?.kind === "workspace" && workspaceTab.remoteSessionId
              ? { remoteSessionId: workspaceTab.remoteSessionId }
              : {}),
          },
          { replaceDraftTabId: replaceId, projectId, taskGroupId },
        );
        return;
      }
      const projectId =
        options?.projectId !== undefined
          ? options.projectId
          : (readComposerWorkspaceScope(workspacePath, workspaceIdentity, composerClientNamespace)
              ?.projectId ?? null);
      const scope = resolveComposerScope(projectId, workspaceIdentity, composerClientNamespace);
      const savedDraft = readV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        scope,
      );
      const taskGroupId =
        options?.taskGroupId !== undefined
          ? options.taskGroupId
          : (savedDraft?.taskGroupId ?? null);
      rememberComposerWorkspaceScope(workspacePath, workspaceIdentity, scope);
      if (workbenchGroupClientMode === "desktop-continuous") {
        const workspaceKey = workspaceIdentity?.trim() || workspacePath;
        const workspaceTab = tabStoreApi
          .getState()
          .tabs.find(
            (tab) =>
              tab.kind === "workspace" &&
              (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
          );
        const tabId = useWorkbenchTabsStore.getState().newDraft(
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspaceTab?.kind === "workspace" && workspaceTab.remoteSessionId
              ? { remoteSessionId: workspaceTab.remoteSessionId }
              : {}),
          },
          { projectId, taskGroupId },
        );
        const draftScopeId = getWorkbenchDraftScopeId(tabId);
        const initialPrompt = options?.initialPrompt;
        // 同目录双栏不能通过 workspace 级插入命令广播；只初始化这一个 Tab 的草稿。
        persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          draftScopeId,
          {
            text: "",
            ...options?.initialComposerDraft?.draft,
            projectId,
            taskGroupId,
            ...(initialPrompt?.trim()
              ? {
                  text: initialPrompt,
                  ...(options?.initialPromptMention
                    ? { mention: options.initialPromptMention }
                    : {}),
                }
              : {}),
          },
          scope,
        );
        if (options?.draftId)
          bindPendingTaskDraft({ ...scope, draftId: tabId }, options.draftId, workspacePath);
        useZCodeSessionStore
          .getState()
          .startDraft(workspacePath, options?.provider, workspaceIdentity, {
            projectId,
            taskGroupId,
          });
        if (options?.initialComposerDraft) {
          stageV4ComposerDraftAttachments(
            workspacePath,
            workspaceIdentity,
            useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .draftFocusVersion,
            options.initialComposerDraft,
            draftScopeId,
          );
        }
        return;
      }
      if (options?.draftId) bindPendingTaskDraft(scope, options.draftId, workspacePath);
      persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        {
          text: "",
          ...(options?.initialComposerDraft?.draft ?? savedDraft),
          projectId,
          taskGroupId,
        },
        scope,
      );
      useZCodeSessionStore
        .getState()
        .startDraft(workspacePath, options?.provider, workspaceIdentity, {
          projectId,
          taskGroupId,
        });
      if (options?.initialComposerDraft) {
        stageV4ComposerDraftAttachments(
          workspacePath,
          workspaceIdentity,
          useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .draftFocusVersion,
          options.initialComposerDraft,
        );
      }
      // 项目草稿只由接收目录的 Root 初始化；mention 的尾空格属于编辑内容。
      const initialPrompt = options?.initialPrompt;
      if (initialPrompt?.trim()) {
        const mention = options?.initialPromptMention;
        persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            projectId,
            taskGroupId,
            ...(mention ? { mention } : {}),
          },
          scope,
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, initialPrompt, workspaceIdentity, mention);
      }
    },
    [workbenchGroupClientMode, composerClientNamespace, tabStoreApi],
  );
  const startNewTaskFromActiveWorkspace = useCallback(
    async (source: string, request?: CreateTaskRequest) => {
      const openRemoteProjectWorkspace = remoteProjectOpener.current;
      const sequence = ++navigationSequence.current;
      const originTab = tabStoreApi.getState().activeTabId;
      const originWorkspace = activeWorkspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined)
        : null;
      const replacementId = typeof request === "object" ? request.replaceDraftTabId : undefined;
      const replacement = replacementId
        ? useWorkbenchTabsStore.getState().tabs[replacementId]
        : undefined;
      if (replacementId && (!replacement || replacement.sessionId !== null)) return;
      const isCurrent = () =>
        (typeof request !== "object" || request.isCurrent?.() !== false) &&
        (replacementId
          ? useWorkbenchTabsStore.getState().tabs[replacementId] === replacement &&
            replacement?.sessionId === null
          : true) &&
        sequence === navigationSequence.current &&
        (Boolean(replacementId) || tabStoreApi.getState().activeTabId === originTab) &&
        (Boolean(replacementId) ||
          !activeWorkspacePath ||
          (() => {
            const state = useZCodeSessionStore
              .getState()
              .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined);
            return (
              state.activeTaskId === originWorkspace?.activeTaskId &&
              state.draftFocusVersion === originWorkspace?.draftFocusVersion
            );
          })());
      try {
        // 在第一次 await 前捕获活动任务/草稿；快捷键和侧栏新建共用同一组织意图。
        const requestOptions = typeof request === "string" ? { provider: request } : { ...request };
        if (
          requestOptions.taskGroupId === undefined &&
          requestOptions.projectId === undefined &&
          readProjectSidebarView() === "grouped" &&
          activeWorkspacePath
        ) {
          const taskId = originWorkspace?.activeTaskId;
          const draftGroupId = originWorkspace?.draftTaskGroupId;
          const structure = taskId ? await services.taskGroupService?.read() : undefined;
          if (!isCurrent()) return;
          requestOptions.taskGroupId = taskId
            ? (structure?.members.find(
                (member) =>
                  member.taskId === taskId &&
                  member.workspaceKey === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
              )?.groupId ?? null)
            : (draftGroupId ?? null);
        }
        request = requestOptions;
        let projectId =
          typeof request === "string"
            ? undefined
            : (request?.projectId ?? request?.targetWorkspace?.projectId);
        let hostId =
          typeof request === "string"
            ? undefined
            : (request?.hostId ?? request?.targetWorkspace?.hostId);
        const hasExplicitProject =
          typeof request === "object" &&
          request !== null &&
          ("projectId" in request || Boolean(request.targetWorkspace?.projectId));
        const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
          resolveWorkbenchNewTaskTarget({
            activeWorkspacePath,
            activeWorkspaceIdentity,
            workbenchScope:
              workbenchGroupClientMode === "desktop-continuous"
                ? getFocusedWorkbenchTab(useWorkbenchTabsStore.getState())?.workspaceScope
                : undefined,
            activeGroup: useWorkbenchGroupStore.getState().activeGroupId
              ? (useWorkbenchGroupStore.getState().groups[
                  useWorkbenchGroupStore.getState().activeGroupId!
                ] ?? null)
              : null,
            paneLayout: usePaneLayoutStore.getState(),
          }),
        );
        if (!hasExplicitProject && newTaskTarget) {
          // 原因：仅远程继承项目会让本地快捷键落入未归类。按任务完整身份读取归属，不能由 cwd 猜项目。
          if (newTaskTarget.workspaceIdentity) {
            hostId =
              remoteHostIdFromWorkspaceIdentity(newTaskTarget.workspaceIdentity) ?? undefined;
            if (!hostId) throw new Error("project.host-identity-required");
          }
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(
              newTaskTarget.workspacePath,
              newTaskTarget.workspaceIdentity ?? undefined,
            );
          const tree = workspace.activeTaskId
            ? await services.projectService?.readTree(hostId ? { hostId } : undefined)
            : undefined;
          if (workspace.activeTaskId && !tree) throw new Error("project.service-unavailable");
          projectId = workspace.activeTaskId
            ? (tree?.tasks.find(
                (task) =>
                  task.taskId === workspace.activeTaskId &&
                  (task.workspaceIdentity?.trim() || task.workspacePath) ===
                    (newTaskTarget.workspaceIdentity?.trim() || newTaskTarget.workspacePath),
              )?.projectId ?? undefined)
            : (workspace.draftProjectId ?? undefined);
          if (hostId && !projectId) throw new Error("project.remote-project-required");
        }
        if (!isCurrent()) return;
        if (!services.projectService) throw new Error("project.service-unavailable");
        const pendingDraft =
          !projectId && (!hostId || hostId === "local")
            ? ensurePendingTaskDraft({
                ...resolveComposerScope(null, undefined, composerClientNamespace),
                ...(replacementId ? { draftId: replacementId } : {}),
              })
            : null;
        const target = await services.projectService.prepareSession({
          ...(projectId ? { projectId } : {}),
          ...(hostId ? { hostId } : {}),
          // 显式 local 与省略 Host 是同一入口，不能漏掉待发送身份而另建目录。
          ...(pendingDraft
            ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
            : {}),
        });
        if (!isCurrent()) return;
        if (hostId && hostId !== "local") {
          if (!target.workspaceIdentity || !openRemoteProjectWorkspace)
            throw new Error("project.remote-navigation-unavailable");
          await openRemoteProjectWorkspace({
            ...target,
            hostId,
            isCurrent,
            ...(typeof request === "object" && request.remoteProjectMembershipId
              ? { expectedMembershipId: request.remoteProjectMembershipId }
              : {}),
          });
        }
        if (!isCurrent()) return;
        const replacementHandoff = replacement
          ? captureV4ComposerDraftHandoff(
              replacement.workspaceScope.workspacePath,
              replacement.workspaceScope.workspaceIdentity,
              composerClientNamespace,
              getWorkbenchDraftScopeId(replacement.draftId ?? replacement.id),
            )
          : undefined;
        // 目录准备成功才提交导航；失败保留当前会话和分屏。
        if (!hostId || hostId === "local")
          addTab(target.workspacePath, {
            workspacePurpose: target.projectId ? "project" : "conversation",
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          });
        startDraftInWorkspace(target.workspacePath, target.workspaceIdentity, {
          ...(typeof request === "string" ? { provider: request } : request),
          ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
          ...(replacementHandoff ? { initialComposerDraft: replacementHandoff } : {}),
          projectId: target.projectId,
        });
        if (typeof request === "object") request.onComplete?.();
        setWorkspaceActionError(null);
        logger.info(`[Root] ${source}`, {
          workspacePath: target.workspacePath,
          projectId: target.projectId,
        });
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("[Root] 准备新任务失败", error);
        if (typeof request === "object") request.onError?.(error);
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      services.projectService,
      composerClientNamespace,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      tabStoreApi,
      addTab,
      workbenchGroupClientMode,
      startDraftInWorkspace,
    ],
  );
  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    createTask: startNewTaskFromActiveWorkspace,
    setWorkspaceActionError,
  });
  const handleSelectProject = useCallback(
    async (path: string) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      try {
        const wslUncWorkspace = parseWslUncWorkspacePath(path);
        if (wslUncWorkspace && onOpenRemoteConnection) {
          const shouldOpenWslConnection = await requestConfirmation({
            title: intl.formatMessage({ id: "workspace.wslUncPrompt.title" }),
            description: intl.formatMessage(
              { id: "workspace.wslUncPrompt.description" },
              {
                path,
              },
            ),
            confirmLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.openWsl" }),
            cancelLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.continuePath" }),
          });
          if (shouldOpenWslConnection) {
            logger.info("[Root] 用户选择通过 WSL 远程连接打开 UNC 工作区", {
              distro: wslUncWorkspace.distro,
              path,
            });
            onOpenRemoteConnection({
              preferredKind: "wsl",
              preferredWslDistro: wslUncWorkspace.distro,
            });
            return;
          }
        }
        // 桌面端：检查是否已有其他窗口打开了该目录，如果是则激活该窗口对应 tab
        const result = await platform.activateOrSetWorkspace(path);
        if (result.activated) {
          logger.info("[Root] 目录已在其他窗口打开，已激活该窗口对应 tab，跳过重复打开");
          return;
        }
        // 新增 tab（如果已在本窗口打开则激活它）
        addTab(path);
        // 打开 workspace 是 workspace-only 意图，不是“继续上次会话”。
        // 即使命中已存在 tab，也必须清掉该 workspace 的 activeTaskId 并回到单 pane 草稿。
        startDraftInWorkspace(path);
        setWorkspaceActionError(null);
      } catch (err) {
        logger.error("[Root] handleSelectProject error:", err);
      }
    },
    [
      addTab,
      intl,
      onOpenRemoteConnection,
      platform,
      requestConfirmation,
      services.settingService,
      startDraftInWorkspace,
      supportsSettings,
    ],
  );
  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web 远程控制当前只保证“进入 desktop 已打开的 workspace”。
      // 之前这里继续放开“打开工作区”，用户会被带进打开工作区中间页，
      // 但后续的新工作区/新会话链路并没有在 Web 远程控制模式里补齐，看起来就像页面一直卡住。
      // 这里直接拦掉入口，避免把用户带进半支持状态。
      logger.info("[Root] 当前模式不支持打开其他工作区，已忽略请求");
      return;
    }
    setWorkspaceActionError(null);
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }
    // 打开工作区中间页作为“新标签页”会在启动空态、Cmd/Ctrl+O
    // 和菜单打开工作区时抢占整页。现在打开工作区只保留为动作：本地优先直接弹系统目录选择，
    // 不再进入中间页面；不支持系统目录选择的壳层由启动兜底负责创建默认 workspace。
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 创建对话 workspace 失败", { error });
      });
      return;
    }
    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);
  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info("[Root] 当前模式不支持从空态菜单打开文件夹，已忽略请求");
      return;
    }
    // 空态 workspace 菜单的 Open folder 需要复用根级打开工作区动作。
    // 因此这里调用同一个入口函数，只把 Root 里的 selectDirectory 与项目选择回调注入进去。
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 从空态菜单创建对话 workspace 失败", { error });
      });
      return;
    }
    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);
  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      return startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );
  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }
    // 设置页返回最近 workspace 时不能只按 path 激活。
    // 同一路径可能存在不同远端身份，丢掉 activeWorkspaceIdentity 会把远程工作区切到 path-only 桶。
    const activated = tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
    const taskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined).activeTaskId;
    if (activated && taskId) {
      notifyTaskNavigationCommitted({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        taskId,
      });
    }
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);
  return {
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
  };
}
