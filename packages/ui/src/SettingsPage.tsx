import { EngineSettings } from "@/external-engine/index.js";
import { SettingsMachinesProvider } from "@/settings/SettingsMachine.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionNavigationPresentation } from "@/lib/remoteConnectionPresentation.js";
/* oxlint-disable eslint(max-lines) */
import { ArrowLeft, Rocket, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  DesktopCloseToTrayCapability,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  Locale,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsSourceServerId,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsModelProviderTarget,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { ArchiveManagement, useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { resolveRecentRemoteProjectPreference } from "@/project-sidebar/remote-project-connection.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { UsageStatsSection } from "@/settings/UsageStatsSection.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import type { AppToolSearchMode } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest, RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import {
  createSettingsPageConfig,
  GeneralSectionContent,
  GeneralSectionHeader,
  TaskAutoArchiveSettings,
  isSettingsSectionAvailable,
  resolveSettingsSectionForPlatform,
} from "@/settingsPageHelpers.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";

function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          active
            ? "bg-surface-hover text-foreground"
            : "text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isWebRemoteControl = false,
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenRemoteWorkspace,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
  /** 远程设备卡「新任务」：激活该设备已打开的 tab 并开新草稿（Root 注入）。 */
  allowOpenWorkspace?: boolean;
}) {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const localHostServices = useBaseWorkspaceServices();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () =>
      createSettingsPageConfig({
        externalEnginesAvailable: Boolean(localHostServices.externalEngineService),
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop, localHostServices.externalEngineService],
  );
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  const remoteWorkspaceController = useOptionalRemoteWorkspaceController();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  const [targetSourceServerId, setTargetSourceServerId] = useState(
    consumePendingSettingsSourceServerId,
  );
  const [targetSourceServerDetails, setTargetSourceServerDetails] = useState(
    consumePendingSettingsSourceServerDetails,
  );
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  // Linux 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）：打开设置页时
  // 经 platform IPC 触发 main 侧探测（带 stale 缓存），用户装完 AppIndicator 扩展重开
  // 设置页即可解除置灰；Web/远控无桥不查询。
  const [linuxCloseToTrayCapability, setLinuxCloseToTrayCapability] =
    useState<DesktopCloseToTrayCapability | null>(null);
  useEffect(() => {
    if (!isLinuxDesktop) {
      return;
    }
    let cancelled = false;
    platform
      .getCloseToTrayCapability?.()
      .then((capability) => {
        if (!cancelled) {
          setLinuxCloseToTrayCapability(capability);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, platform]);
  const linuxCloseToTray = isLinuxDesktop
    ? {
        // 探测中按不可用锁定，防止查询完成前误开导致关窗失联
        disabled: linuxCloseToTrayCapability === null || !linuxCloseToTrayCapability.supported,
        unavailable: linuxCloseToTrayCapability?.supported === false,
        gnomeLikeHint:
          linuxCloseToTrayCapability?.supported === false &&
          linuxCloseToTrayCapability.gnomeLikeWithoutTray,
      }
    : undefined;
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useZCodeStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useZCodeStore((state) => state.setNotificationSoundEnabled);
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const setNewUserOnboardingOpen = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  const requestOnboardingDialog = () => setNewUserOnboardingOpen(true);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      // 能力隐藏的分区也可能收到历史或外部跳转意图；按可见分区解析，避免渲染空页。
      const resolvedSection = resolveSettingsSectionForPlatform(
        resolveSettingsSection(section, fallbackSection),
        settingsSections,
        fallbackSection,
      );
      setActiveSection(resolvedSection);
      writeLastSettingsSectionPreference(resolvedSection);
    },
    [activeSection, settingsSections],
  );
  useEffect(() => {
    if (!isDesktop && activeSection === "remoteDevices") {
      setActiveSettingsSection("general");
    }
  }, [activeSection, isDesktop, setActiveSettingsSection]);
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activateTab = useTabStore((state) => state.activateTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const selectDirectory = useSelectDirectory();
  const services = useServices();
  const onboardingRecordService = services.onboardingRecordService;
  const projectDirectory = useOptionalProjectDirectory();
  // SettingsPage 可能挂在远端 workspace 的 ServiceProvider 下；共享设置属于本机 Host，
  // 读写必须固定走本机 settingService，否则会写进远端 setting。
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings({
    services: localHostServices,
  });
  const sourceManagement = localHostServices.sourceServerManagementService;
  const { snapshot: sourceManagementSnapshot } = useSourceServerManagementSnapshot(
    sourceManagement,
    {
      onError: (error) =>
        logger.warn("[SettingsPage] 读取 Source 状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  const remoteDevicesPresentation = useMemo(
    () => resolveRemoteConnectionNavigationPresentation(sourceManagementSnapshot),
    [sourceManagementSnapshot],
  );
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  const memoryEnabled = sharedSettings?.memoryEnabled === true;
  const toolSearchMode = sharedSettings?.toolSearchMode ?? "off";
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(30);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(Boolean(isWindowsDesktop));
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  const [toolGroupingExploreEnabled, setToolGroupingExploreEnabled] = useState(true);
  const [toolGroupingTerminalEnabled, setToolGroupingTerminalEnabled] = useState(true);
  const [toolGroupingChangesEnabled, setToolGroupingChangesEnabled] = useState(false);
  const [zcodeInteractionBehavior, setZCodeInteractionBehavior] =
    useState<ZCodeInteractionBehavior>("queue");
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        setTargetSourceServerId(section === "remoteDevices" ? detail?.sourceServerId : undefined);
        setTargetSourceServerDetails(
          section === "remoteDevices" && detail?.sourceServerDetails === true,
        );
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          setPluginTab(detail.pluginTab);
          setPluginNavigationOrigin(detail.pluginOrigin);
          setPluginScopeKey(detail.pluginScopeKey);
        } else if (resolveSettingsSection(section) !== "plugin") {
          setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    let active = true;
    // 修复原因：远程 tab 的 services 属于 Source，但 Main 启动、native picker 和
    // 本机 shell 枚举都使用 Desktop 配置；读写必须同属 base Host，不能随 tab 切换。
    localHostServices.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setDataBaseDir(settings.dataBaseDir ?? "");
        setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        setHttpProxy(settings.httpProxy ?? "");
        setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? Boolean(isWindowsDesktop));
        setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
      })
      .catch(() => {});
    localHostServices.systemService
      .info()
      .then((info) => {
        if (!active) return;
        setDefaultHomeDir(info.homedir);
        setHostPlatform(info.platform);
        if (info.platform !== "win32") {
          setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then((options) => {
            if (active) setIntegratedTerminalShellOptions(options);
          })
          .catch(() => {
            if (active) setIntegratedTerminalShellOptions([]);
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [localHostServices.systemService, localHostServices.settingService, isWindowsDesktop]);

  useEffect(() => {
    let active = true;
    // 终端 Profile 与任务归档由目标 Environment 消费，仍读 Source；切换后丢弃旧响应。
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        setTerminalFontFamily(settings.terminalFontFamily ?? "");
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 30);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [services.settingService]);

  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    setToolGroupingExploreEnabled(sharedSettings.toolGroupingExploreEnabled ?? true);
    setToolGroupingTerminalEnabled(sharedSettings.toolGroupingTerminalEnabled ?? true);
    setToolGroupingChangesEnabled(sharedSettings.toolGroupingChangesEnabled ?? false);
    setZCodeInteractionBehavior(sharedSettings.zcodeInteractionBehavior ?? "queue");
  }, [sharedSettings]);
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await services.settingService.update({ terminalInheritSystemProfile: enabled });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService],
  );
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await services.settingService.update({ terminalFontFamily: normalizedFontFamily });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService],
  );
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await localHostServices.settingService.update({ integratedTerminalShell: selection });
      setIntegratedTerminalShell(selection);
    },
    [localHostServices.settingService],
  );
  const handleToolSearchModeChange = useCallback(
    async (mode: AppToolSearchMode) => {
      await updateSharedSettings({ toolSearchMode: mode });
    },
    [updateSharedSettings],
  );
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled });
    },
    [updateSharedSettings],
  );
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ askUserQuestionAutoResolutionEnabled: enabled });
    },
    [updateSharedSettings],
  );
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ modelIoFullRetentionEnabled: enabled });
    },
    [updateSharedSettings],
  );
  const handleMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      await (async () => {
        await updateSharedSettings({ memoryEnabled: enabled });
        // 手动修改反向回写 record，换号同步不会复活旧值；失败不阻塞开关。
        await onboardingRecordService
          ?.updateRecordPreferences({ memoryEnabled: enabled })
          .catch((cause: unknown) => {
            console.warn("[settings] 回写引导记录失败", String(cause));
          });
      })();
    },
    [updateSharedSettings],
  );
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await localHostServices.settingService.update({
        // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
        httpProxy: normalizedProxy,
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await localHostServices.settingService.update({
        // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
        httpProxyNoProxy: normalizedNoProxy,
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await localHostServices.settingService.update({
        // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
        httpProxyCaCertPath: normalizedCaCertPath,
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await localHostServices.settingService.updateDataBaseDir(dir || undefined);
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [localHostServices.settingService],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await services.settingService.update({ taskAutoArchiveEnabled: enabled });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await services.settingService.update({ taskAutoArchiveOlderThanDays: days });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await localHostServices.settingService.update({ closeToTrayOnWindows: enabled });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [localHostServices.settingService, platform],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ keepAwakeWhileRunning: enabled });
    },
    [updateSharedSettings],
  );
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await localHostServices.settingService.update({
        desktopChromiumHardwareAccelerationEnabled: enabled,
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await localHostServices.settingService.update({
        embeddedBrowserAllowInsecureCertificates: enabled,
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ messageStreamShowReasoning: enabled });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ messageStreamShowTodos: enabled });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingExploreEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ toolGroupingExploreEnabled: enabled });
      setToolGroupingExploreEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingTerminalEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ toolGroupingTerminalEnabled: enabled });
      setToolGroupingTerminalEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingChangesEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ toolGroupingChangesEnabled: enabled });
      setToolGroupingChangesEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleZCodeInteractionBehaviorChange = useCallback(
    async (behavior: ZCodeInteractionBehavior) => {
      await updateSharedSettings({ zcodeInteractionBehavior: behavior });
      setZCodeInteractionBehavior(behavior);
    },
    [updateSharedSettings],
  );
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        setLocalePreference("system");
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        setLocalePreference(value as Locale);
      }
    },
    [setLocalePreference],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value as Theme);
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      return setCodePreviewSettings(patch);
    },
    [setCodePreviewSettings],
  );
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");

  return (
    <>
      <DesktopWindowFrame
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]"
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {usesInlineWindowControls ? (
            <div
              className={cn(
                "absolute z-30 mt-px mr-px flex h-12 items-center gap-0.5 px-2 pointer-events-auto [app-region:no-drag]",
                // 外沿留白变化后，悬浮操作组也必须同步，否则与内容 Header 错位。
                isWindowsDesktop ? "right-1.5 top-1.5" : "right-1 top-1",
              )}
            >
              {/* Bug 原因：Windows/Linux 设置页仍保留旧 caption 下箭头，与主界面和 macOS 的帮助入口不一致。
                  统一复用问号帮助按钮，并让它在普通 flex 流中紧邻自绘窗控。
                  Settings 的独立标题层还需计入 4px 外层留白和 1px 边框，才能与 Workspace 控制组对齐。 */}
              <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />
              <DesktopWindowControls />
            </div>
          ) : null}
          <aside className="min-w-0">
            <div className="flex h-full flex-col">
              <div className="h-12 [app-region:drag]"></div>
              <div className="px-2 pb-3 pt-3">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl bg-surface px-1.5 text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      onClick={() => {
                        (() => {
                          if (pluginNavigationOrigin === "plugin-store") {
                            requestPluginStoreOpen("user");
                          }
                          onBack?.();
                        })();
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}
              </div>

              <nav
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                className="flex-1 overflow-y-auto px-2 pb-3"
              >
                <div className="space-y-4">
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-1",
                          groupIndex > 0 && "max-lg:border-t max-lg:border-border max-lg:pt-3",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections
                          .filter(({ id }) => isSettingsSectionAvailable(id, Boolean(isDesktop)))
                          .map(({ id, icon: Icon, titleId }) => {
                            const isActive = activeSection === id;
                            const label = intl.formatMessage({ id: titleId });

                            return (
                              <SettingsSidebarButton
                                key={id}
                                icon={Icon}
                                label={label}
                                active={isActive}
                                aria-current={isActive ? "page" : undefined}
                                data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                                data-settings-section-nav={id}
                                onClick={() => {
                                  (() => {
                                    setPluginNavigationOrigin(undefined);
                                    setTargetSourceServerId(undefined);
                                    setSettingsSectionNavigationVersion((version) => version + 1);
                                    setActiveSettingsSection(id);
                                  })();
                                }}
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate text-ui-base text-foreground">
                                    {label}
                                  </span>
                                  {id === "remoteDevices" ? (
                                    <RemoteConnectionNavigationDot
                                      presentation={remoteDevicesPresentation}
                                    />
                                  ) : null}
                                </span>
                              </SettingsSidebarButton>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>

                <SettingsSidebarButton
                  icon={Rocket}
                  label={intl.formatMessage({ id: "settings.onboarding" })}
                  className="mt-4 border border-dashed border-border hover:border-border-hover"
                  onClick={() => {
                    requestOnboardingDialog();
                  }}
                >
                  <span className="text-ui-base text-foreground">
                    {intl.formatMessage({ id: "settings.onboarding" })}
                  </span>
                </SettingsSidebarButton>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  theme={theme}
                  localeMenuValue={localePreference}
                  onLocaleChange={handleFooterLocaleChange}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={onBack}
                  settingsButtonMode="back"
                  // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
                  // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
                  isDesktop={isDesktop}
                />
              </div>
            </div>
          </aside>

          <section
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              isDesktop ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            )}
          >
            <div
              data-settings-top-inset={isDesktop ? "true" : undefined}
              // 下方面板使用 h-full；顶部留白不能参与 flex 收缩，否则 6px 会变成小数像素。
              className={cn(
                "shrink-0 [app-region:drag]",
                isDesktop && (isWindowsDesktop ? "h-1.5" : "h-1"),
                isMacDesktop && "max-lg:h-16",
              )}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "relative flex flex-col min-h-0 h-full border border-border bg-background",
                // 直接写像素圆角会绕过设计 token；设置页与工作区统一复用 rounded-md（默认 6px）。
                isWindowsDesktop ? "rounded-md" : "rounded-xl",
              )}
            >
              {!usesInlineWindowControls ? (
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                      isDesktop={Boolean(isDesktop)}
                    />
                  </div>
                </div>
              ) : null}
              <SettingsBreadcrumbProvider
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角帮助/窗口按钮命中区域重叠；
                      // 这里把右侧按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      // Windows/Linux 设置页共同避开右上角菜单与内联窗控组。

                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 四个 28px 按钮、组内 2px 间距和左右 8px padding，共 134px。
                        usesInlineWindowControls ? "mr-[134px]" : "mr-12",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <SettingsMachinesProvider servers={sourceManagementSnapshot?.servers ?? []}>
                    <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                      <div
                        className={cn(
                          SETTINGS_FRAME_CONTENT_CLASSNAME,
                          "flex flex-col gap-8",
                          isMacDesktop && "pt-0",
                          // isWindowsDesktop && "pt-12",
                        )}
                      >
                        {/* 归档设置迁入后也需要公共页头，不能再因列表自带标题而隐藏页面标题。 */}
                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                              {showActiveSectionTitle ? (
                                <h2 className="text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
                                  {activeSectionLabel}
                                </h2>
                              ) : null}
                              {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                                <span className="inline-flex h-6 items-center rounded-md border border-border px-2 text-ui-xs font-semibold tracking-normal text-foreground">
                                  {intl.formatMessage({
                                    id: activeSectionMeta.titleBadgeId,
                                  })}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {activeSection === "general" ? (
                            <GeneralSectionHeader localePreference={localePreference} />
                          ) : null}
                        </div>
                        <div className="space-y-8">
                          {activeSection === "general" ? (
                            <GeneralSectionContent
                              localePreference={localePreference}
                              interfaceMode={interfaceMode}
                              setInterfaceMode={setInterfaceMode}
                              isDesktop={isDesktop}
                              isWindowsDesktop={isWindowsDesktop}
                              isLinuxDesktop={isLinuxDesktop}
                              linuxCloseToTray={linuxCloseToTray}
                              platform={platform}
                              notificationEnabled={notificationEnabled}
                              notificationSoundEnabled={notificationSoundEnabled}
                              closeToTrayOnWindows={closeToTrayOnWindows}
                              keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
                              desktopChromiumHardwareAccelerationEnabled={
                                desktopChromiumHardwareAccelerationEnabled
                              }
                              dataBaseDir={dataBaseDir}
                              terminalInheritSystemProfile={terminalInheritSystemProfile}
                              terminalFontFamily={terminalFontFamily}
                              integratedTerminalShell={integratedTerminalShell}
                              integratedTerminalShellOptions={integratedTerminalShellOptions}
                              toolSearchMode={toolSearchMode}
                              onToolSearchModeChange={handleToolSearchModeChange}
                              nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
                              httpProxy={httpProxy}
                              httpProxyNoProxy={httpProxyNoProxy}
                              httpProxyCaCertPath={httpProxyCaCertPath}
                              defaultHomeDir={defaultHomeDir}
                              showIntegratedTerminalShell={hostPlatform === "win32"}
                              setLocalePreference={handleFooterLocaleChange}
                              setNotificationEnabled={(enabled) => setNotificationEnabled(enabled)}
                              setNotificationSoundEnabled={(enabled) =>
                                setNotificationSoundEnabled(enabled)
                              }
                              messageStreamShowReasoning={messageStreamShowReasoning}
                              messageStreamShowTodos={messageStreamShowTodos}
                              toolGroupingExploreEnabled={toolGroupingExploreEnabled}
                              toolGroupingTerminalEnabled={toolGroupingTerminalEnabled}
                              toolGroupingChangesEnabled={toolGroupingChangesEnabled}
                              zcodeInteractionBehavior={zcodeInteractionBehavior}
                              askUserQuestionAutoResolutionEnabled={
                                askUserQuestionAutoResolutionEnabled
                              }
                              modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
                              onDataBaseDirChange={handleDataBaseDirChange}
                              onSelectDataBaseDir={selectDirectory}
                              onTerminalInheritSystemProfileChange={
                                handleTerminalInheritSystemProfileChange
                              }
                              onTerminalFontFamilyChange={handleTerminalFontFamilyChange}
                              onIntegratedTerminalShellChange={handleIntegratedTerminalShellChange}
                              onNativeSearchEnhancementsEnabledChange={
                                handleNativeSearchEnhancementsEnabledChange
                              }
                              onModelIoFullRetentionEnabledChange={
                                handleModelIoFullRetentionEnabledChange
                              }
                              onHttpProxyChange={handleHttpProxyChange}
                              onHttpProxyNoProxyChange={handleHttpProxyNoProxyChange}
                              onHttpProxyCaCertPathChange={handleHttpProxyCaCertPathChange}
                              onCloseToTrayOnWindowsChange={handleCloseToTrayOnWindowsChange}
                              onKeepAwakeWhileRunningChange={handleKeepAwakeWhileRunningChange}
                              onDesktopChromiumHardwareAccelerationChange={
                                handleDesktopChromiumHardwareAccelerationChange
                              }
                              onMessageStreamShowReasoningChange={
                                handleMessageStreamShowReasoningChange
                              }
                              onMessageStreamShowTodosChange={handleMessageStreamShowTodosChange}
                              onToolGroupingExploreEnabledChange={
                                handleToolGroupingExploreEnabledChange
                              }
                              onToolGroupingTerminalEnabledChange={
                                handleToolGroupingTerminalEnabledChange
                              }
                              onToolGroupingChangesEnabledChange={
                                handleToolGroupingChangesEnabledChange
                              }
                              onZCodeInteractionBehaviorChange={
                                handleZCodeInteractionBehaviorChange
                              }
                              onAskUserQuestionAutoResolutionEnabledChange={
                                handleAskUserQuestionAutoResolutionEnabledChange
                              }
                              onOpenOnboardingDialog={() => requestOnboardingDialog()}
                            />
                          ) : activeSection === "remoteDevices" ? (
                            sharedSettings && isDesktop && sourceManagement ? (
                              <SourceServerManagementPanel
                                key={`remote:${settingsSectionNavigationVersion}`}
                                targetSourceServerId={targetSourceServerId}
                                targetSourceServerDetails={targetSourceServerDetails}
                                onTargetSourceServerFocused={() => {
                                  setTargetSourceServerId(undefined);
                                  setTargetSourceServerDetails(false);
                                }}
                                management={sourceManagement}
                                onCreateConnection={
                                  onOpenRemoteWorkspace
                                    ? () =>
                                        onOpenRemoteWorkspace({ completion: "device-management" })
                                    : undefined
                                }
                                onConnectProfile={
                                  remoteWorkspaceController
                                    ? (profileId) =>
                                        remoteWorkspaceController.dispatch({
                                          type: "connect-device",
                                          profileId,
                                          effect: "device-management",
                                        })
                                    : onOpenRemoteWorkspace
                                      ? (profileId) =>
                                          onOpenRemoteWorkspace({
                                            preferredProfileId: profileId,
                                            completion: "device-management",
                                          })
                                      : undefined
                                }
                                onDisconnectSource={
                                  remoteWorkspaceController
                                    ? (sourceServerId) =>
                                        remoteWorkspaceController.dispatch({
                                          type: "disconnect-device",
                                          sourceServerId,
                                        })
                                    : undefined
                                }
                                onOpenProject={
                                  onOpenRemoteWorkspace
                                    ? async (sourceServerId, path, profileId) => {
                                        // 仅传目录会被 Root 当成新建；复用侧栏唯一目录 owner，同步固定原入口。
                                        const preference =
                                          projectDirectory &&
                                          resolveRecentRemoteProjectPreference(
                                            projectDirectory.directory,
                                            {
                                              sourceServerId,
                                              path,
                                              profileId,
                                            },
                                          );
                                        if (!preference) {
                                          throw Object.assign(
                                            new Error("remote-project.entry-not-found"),
                                            {
                                              code: "recent-project-unresolved",
                                            },
                                          );
                                        }
                                        onBack?.();
                                        onOpenRemoteWorkspace(preference);
                                      }
                                    : undefined
                                }
                                onShowUpdateDetails={(sourceServerId) => {
                                  setPendingSettingsSectionIntent("remoteDevices", {
                                    sourceServerId,
                                    sourceServerDetails: true,
                                  });
                                  openSettingsTab();
                                }}
                                workspaceTabs={workspaceTabs}
                                onShowInSidebar={(sourceServerId) => {
                                  const target = workspaceTabs.find(
                                    (tab) =>
                                      getWorkspaceSourceServerId(tab, {
                                        workspaceHistory:
                                          sourceManagementSnapshot?.workspaceHistory,
                                      }) === sourceServerId,
                                  );
                                  onBack?.();
                                  if (target) {
                                    activateTab(target.id);
                                    requestAnimationFrame(() => {
                                      const row = Array.from(
                                        document.querySelectorAll<HTMLElement>(
                                          "[data-remote-project-identity]",
                                        ),
                                      ).find(
                                        (element) =>
                                          element.dataset.remoteProjectIdentity ===
                                          target.workspaceIdentity,
                                      );
                                      row?.scrollIntoView({ block: "center" });
                                      row
                                        ?.querySelector<HTMLElement>('[role="button"]')
                                        ?.focus({ preventScroll: true });
                                    });
                                  }
                                }}
                                settings={sharedSettings}
                                onUpdateSettings={updateSharedSettings}
                              />
                            ) : (
                              <p className="text-ui-sm text-remote-foreground-muted">
                                {intl.formatMessage({
                                  id: sharedSettings ? "settings.source.empty" : "common.loading",
                                })}
                              </p>
                            )
                          ) : activeSection === "appearance" ? (
                            <AppearanceSectionContent
                              codePreviewSettings={codePreviewSettings}
                              setCodePreviewSettings={handleCodePreviewSettingsChange}
                              theme={theme}
                              setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
                              uiFontSizePx={uiFontSizePx}
                              setUiFontSizePx={(fontSizePx) => setUiFontSizePx(fontSizePx)}
                            />
                          ) : activeSection === "shortcuts" ? (
                            <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
                          ) : activeSection === "modelProvider" ? (
                            <ServiceProvider services={localHostServices}>
                              {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
                              <ModelProviderSection
                                workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                                connectivityWorkspacePath={
                                  localModelProviderConnectivityWorkspacePath
                                }
                                connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
                                pendingModelProviderTarget={pendingModelProviderTarget}
                                onConsumePendingModelProviderTarget={() =>
                                  setPendingModelProviderTarget(undefined)
                                }
                              />
                            </ServiceProvider>
                          ) : activeSection === "agentEngines" ? (
                            <ServiceProvider services={localHostServices}>
                              {/* 引擎安装属于本机 Host；远端 workspace 不能改变设置页的服务所有者。 */}
                              <EngineSettings />
                            </ServiceProvider>
                          ) : activeSection === "memory" ? (
                            <ServiceProvider services={localHostServices}>
                              {/* Memory catalog 始终使用本地 Host，避免远程 workspace 误读本机数据。 */}
                              <MemorySettingsSection
                                memoryEnabled={memoryEnabled}
                                memoryService={localHostServices.memoryService}
                                onMemoryEnabledChange={handleMemoryEnabledChange}
                                projectMemoryViewerAvailable={Boolean(isDesktop)}
                                workspaceDisplayNames={memoryWorkspaceDisplayNames}
                              />
                            </ServiceProvider>
                          ) : activeSection === "plugin" ? (
                            <PluginsSection
                              key={`plugin:${settingsSectionNavigationVersion}`}
                              isDesktop={Boolean(isDesktop)}
                              isMacDesktop={Boolean(isMacDesktop)}
                              isWindowsDesktop={Boolean(isWindowsDesktop)}
                              isWebRemoteControl={isWebRemoteControl}
                              initialTab={pluginTab}
                              initialScopeKey={pluginScopeKey}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "mcp" ? (
                            <PluginsSection
                              key={`mcp:${settingsSectionNavigationVersion}`}
                              mode="mcp"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "skill" ? (
                            <PluginsSection
                              key={`skill:${settingsSectionNavigationVersion}`}
                              mode="skill"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "migration" ? (
                            <MigrationSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              isDesktop={isDesktop}
                            />
                          ) : activeSection === "archives" ? (
                            <div className="min-w-0 space-y-6">
                              <TaskAutoArchiveSettings
                                taskAutoArchiveEnabled={taskAutoArchiveEnabled}
                                taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
                                onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
                                onTaskAutoArchiveOlderThanDaysChange={
                                  handleTaskAutoArchiveOlderThanDaysChange
                                }
                              />
                              <ArchiveManagement />
                            </div>
                          ) : activeSection === "usage" ? (
                            <UsageStatsSection />
                          ) : activeSection === "subagents" ? (
                            <SubagentsSection
                              onManageModels={handleOpenModelProviderSettings}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "automations" ? (
                            <AutomationsSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "commands" ? (
                            <PluginsSection
                              mode="command"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "hooks" ? (
                            <HooksSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "workspaceFileSearch" ? (
                            <WorkspaceFileSearchSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "browser" ? (
                            <BrowserSettingsSection
                              isDesktop={Boolean(isDesktop)}
                              isWindowsDesktop={isWindowsDesktop}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              embeddedBrowserAllowInsecureCertificates={
                                embeddedBrowserAllowInsecureCertificates
                              }
                              onEmbeddedBrowserAllowInsecureCertificatesChange={
                                handleEmbeddedBrowserAllowInsecureCertificatesChange
                              }
                            />
                          ) : activeSection === "computerUse" ? (
                            <ComputerUseSection
                              isDesktop={Boolean(isDesktop)}
                              isMacDesktop={Boolean(isMacDesktop)}
                              isWindowsDesktop={Boolean(isWindowsDesktop)}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              remoteSessionId={activeWorkspaceTab?.remoteSessionId}
                              remoteTarget={activeWorkspaceTab?.remoteTarget}
                              localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
                            />
                          ) : null}
                        </div>
                      </div>
                    </main>
                  </SettingsMachinesProvider>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
      </DesktopWindowFrame>
    </>
  );
}
