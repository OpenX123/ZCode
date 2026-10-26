import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { createQuickPickCommands } from "@/quickpick/quickPickCommands.js";
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  activateNewTabSidePane,
  openTerminalSidePane,
  closeSidePaneTab,
  stampSidePaneTabsOwnership,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { PanelImperativeHandle } from "react-resizable-panels";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.add(`theme-zai-${params.get("theme") ?? "light"}`);
const workspacePath = "/workspace/native claude";
const workspaceIdentity = "fixture-workspace";
const remoteSessionId = undefined;
const noop = () => {};
const calls = { creates: [] as unknown[], writes: [] as unknown[], disposed: [] as string[] };
const publish = () => {
  document.querySelector('[data-testid="calls"]')!.textContent = JSON.stringify(calls);
};
// 夹具只验证交互链路，不启动真实 CLI、不调用模型 API。
const services = {
  terminalService: {
    create: async (input: { program?: string }) => {
      calls.creates.push(input);
      publish();
      return {
        id: String(calls.creates.length),
        shell: "/bin/zsh",
        fontFamily: "monospace",
        fontFamilySource: "default",
        ...(params.has("oldHost") ? {} : { program: input.program }),
      };
    },
    write: async (input: unknown) => {
      calls.writes.push(input);
      publish();
    },
    resize: async () => {},
    dispose: async ({ id }: { id: string }) => {
      calls.disposed.push(id);
      publish();
    },
    onDynamicData: () => (listener: (data: string) => void) => {
      listener("\r\nClaude Code fixture: auto\r\n");
      return { dispose: noop };
    },
    onDynamicExit: () => () => ({ dispose: noop }),
  },
} as unknown as IServiceAccessor;

function Fixture() {
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(() =>
    stampSidePaneTabsOwnership(activateNewTabSidePane(null), {
      workspaceKey: workspaceIdentity,
      ownerTaskId: null,
    }),
  );
  const [attached, setAttached] = useState(true);
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (attached) panelRef.current?.resize("55%");
  }, [attached]);
  const openTerminal = (program?: "claude-code") =>
    setSidePaneState((current) =>
      stampSidePaneTabsOwnership(
        openTerminalSidePane(current, {
          title: program ? "Claude Code" : "Terminal",
          cwd: workspacePath,
          program,
        }),
        { workspaceKey: workspaceIdentity, ownerTaskId: null },
      ),
    );
  const commands = createQuickPickCommands({
    allowOpenWorkspace: true,
    isSidebarVisible: true,
    supportsTerminal: true,
    themeTarget: "dark",
    shortcuts: { newTask: "", openWorkspace: "", toggleSidebar: "", toggleTerminal: "" },
    handlers: {
      createTask: noop,
      openWorkspace: noop,
      openSettings: noop,
      openSkillsSettings: noop,
      openMcpSettings: noop,
      switchTheme: noop,
      toggleSidebar: noop,
      toggleTerminal: noop,
      togglePreview: noop,
      openTerminalTab: openTerminal,
      openBrowserTab: noop,
      openReviewTab: noop,
    },
  });
  const panel = (
    <AnimatedSidePanePanel
      services={services}
      isVisible
      isDesktop={!params.has("mobile")}
      mobileOverlay={params.has("mobile")}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={[]}
      isBrowserOpen={false}
      supportsEmbeddedBrowser={false}
      workspaceAbsPath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={remoteSessionId}
      activeTaskId={null}
      sidePaneOwnerId={null}
      gitState={{} as Parameters<typeof AnimatedSidePanePanel>[0]["gitState"]}
      activeGitSourceId="unstaged"
      panelRef={panelRef}
      panelElementRef={panelElementRef}
      browserNavigationRequest={null}
      browserRestoreUrls={{}}
      fileChangeFindActiveIndex={0}
      fileChangeFindNavigationRequestId={0}
      fileChangeFindQuery=""
      onFileChangeFindMatchCountChange={noop}
      onCloseCodeViewer={noop}
      onCloseGit={noop}
      onActivateTab={(id) =>
        setSidePaneState((current) => (current ? { ...current, activeTabId: id } : current))
      }
      onOpenNewTab={() =>
        setSidePaneState((current) =>
          stampSidePaneTabsOwnership(activateNewTabSidePane(current), {
            workspaceKey: workspaceIdentity,
            ownerTaskId: null,
          }),
        )
      }
      onReorderTab={noop}
      onCloseTab={(id) => {
        sidePaneTerminalSessionRegistry.release(id);
        setSidePaneState((state) => closeSidePaneTab(state, id));
      }}
      onCloseOtherTabs={noop}
      onCloseAllTabs={noop}
      onReopenClosedTab={noop}
      onOpenBrowserTab={noop}
      onOpenWhiteboard={noop}
      onOpenDeveloperTools={noop}
      onOpenPluginMarket={noop}
      onOpenTerminalTab={openTerminal}
      onOpenReviewTab={noop}
      onOpenSelectionSideConversation={noop}
      onOpenBrowserUrl={noop}
      onOpenCodeViewer={noop}
      onOpenSubagentSession={noop}
      onRefreshGit={noop}
      onBrowserNavigationRequestHandled={noop}
      onBrowserUrlChange={noop}
      onBrowserPageMetadataChange={noop}
      onSelectGitSource={noop}
    />
  );
  return (
    <main className="h-screen min-w-0 bg-background text-foreground">
      <button
        data-testid="command-claude"
        onClick={() => commands.find((item) => item.id === "open-claude-code")!.run()}
      >
        Command: Claude Code
      </button>
      <button data-testid="detach" onClick={() => setAttached((value) => !value)}>
        Detach/attach
      </button>
      <output data-testid="calls" hidden>
        {JSON.stringify(calls)}
      </output>
      <div className="h-5/6 min-w-0">
        {attached ? (
          <PlatformProvider platform={{} as IPlatformService}>
            {params.has("mobile") ? (
              panel
            ) : (
              <ResizablePanelGroup layoutId="claude-fixture" orientation="horizontal">
                <ResizablePanel defaultSize={40}>
                  <div />
                </ResizablePanel>
                {panel}
              </ResizablePanelGroup>
            )}
          </PlatformProvider>
        ) : null}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
