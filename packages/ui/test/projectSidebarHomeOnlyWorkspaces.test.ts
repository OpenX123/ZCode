// @vitest-environment jsdom
import { createElement, Fragment, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";

const Sidebar = (props: ProjectSidebarProps) =>
  createElement(
    TooltipProvider,
    null,
    createElement(ProjectDirectoryProvider, null, createElement(WorkspaceSidebar, props)),
  );

const fixture = vi.hoisted(() => ({
  state: { tabs: [], activeWorkspaceIdentity: null, openSettingsTab: () => {} },
  hasProjectService: false,
  toast: vi.fn(),
  renderSidebar: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const projectService = { readTree: async () => ({ projects: [], tasks: [] }) };
  const remoteProjectService = { readDirectory: async () => ({ hosts: [], entries: [] }) };
  const base = {
    get projectService() {
      return fixture.hasProjectService ? projectService : undefined;
    },
    get remoteProjectService() {
      return fixture.hasProjectService ? remoteProjectService : undefined;
    },
    zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose() {} }) },
    broadcastService: { onMessage: () => ({ dispose() {} }) },
  };
  return { useBaseWorkspaceServices: () => base };
});
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  useOptionalTabStore: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  // 项目目录的未读监听使用原 store 的订阅接口，首页夹具也需提供可释放的订阅。
  useTabStoreApi: () => ({ getState: () => fixture.state, subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: () => true,
  useZCodeStore: (selector: (state: unknown) => unknown) => selector({ setTheme: () => {} }),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    localePreference: "en-US",
    setLocalePreference: () => {},
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: fixture.toast }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
vi.mock("@/hooks/usePlatform.js", () => ({
  useSelectDirectory: () => () => {},
  useOptionalPlatform: () => null,
}));
vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: () => createElement("footer", {}, "Footer"),
}));
vi.mock("@/NewTaskButtonGroup.js", () => ({
  NewTaskButtonGroup: () => createElement("button", {}, "New task"),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
vi.mock("@/project-sidebar/useProjectTaskNavigation.js", () => ({
  useProjectTaskNavigation: (props: ProjectSidebarProps) => {
    fixture.renderSidebar();
    return props.onSelectTask;
  },
}));

// 独立桌面已移除手机 relay，旧宿主即使传入额外字段也不能恢复桥接调用。
function createRetiredSwitcher() {
  return {
    listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
    onWorkspaceListUpdated: vi.fn(() => () => {}),
    switchWorkspace: vi.fn(async () => {}),
    reconnectWorkspace: vi.fn(async () => {}),
  };
}

function props(overrides: Partial<ProjectSidebarProps> = {}): ProjectSidebarProps {
  return {
    workspacePath: "/local",
    theme: "light",
    onSelectTask: vi.fn(),
    onCreateTask: vi.fn(),
    onCreateConversationTask: vi.fn(),
    onStartDraftInWorkspace: vi.fn(),
    onOpenFolderFromWorkspaceMenu: vi.fn(),
    onConnectRemote: vi.fn(async () => "logical"),
    onSelectRemoteProject: vi.fn(async () => {}),
    onCancelRemoteProject: vi.fn(async () => {}),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    onOpenCommandCenter: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  fixture.hasProjectService = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("独立桌面项目侧栏不恢复已退役的首页 relay 列表", () => {
  it("缺少项目服务时呈现本地错误，不查询或订阅旧 relay", async () => {
    const switcher = createRetiredSwitcher();
    render(
      createElement(
        Sidebar,
        Object.assign(props({ isWebRemoteControl: true }), {
          webRemoteControlWorkspaceSwitcher: switcher,
        }),
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Error: project.service-unavailable",
    );
    for (const method of Object.values(switcher)) expect(method).not.toHaveBeenCalled();
    expect(screen.queryByText("webRemoteControl.homeOnlyWorkspaces")).toBeNull();
    expect(screen.queryByText("webRemoteControl.noSwitchableWorkspaces")).toBeNull();
  });

  it("项目服务可用时展示项目视图，不启用旧 relay 后备通道", async () => {
    fixture.hasProjectService = true;
    const switcher = createRetiredSwitcher();
    render(
      createElement(
        Sidebar,
        Object.assign(props(), { webRemoteControlWorkspaceSwitcher: switcher }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("common.loading")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("virtual-project-new-task")).toBeTruthy();
    for (const method of Object.values(switcher)) expect(method).not.toHaveBeenCalled();
  });

  it("跳过无关父更新，导航回调变更仍更新侧栏", async () => {
    fixture.hasProjectService = true;
    const stableProps = props();
    function Parent() {
      const [revision, update] = useState(0);
      const [onCreateTask, setOnCreateTask] = useState(() => stableProps.onCreateTask);
      return createElement(
        Fragment,
        null,
        createElement("button", { onClick: () => update(revision + 1) }, "Unrelated update"),
        createElement(
          "button",
          { onClick: () => setOnCreateTask(() => vi.fn()) },
          "Navigation update",
        ),
        createElement(WorkspaceSidebar, { ...stableProps, onCreateTask }),
      );
    }
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ProjectDirectoryProvider, null, createElement(Parent)),
      ),
    );
    await waitFor(() => expect(screen.queryByText("common.loading")).toBeNull());
    fixture.renderSidebar.mockClear();
    fireEvent.click(screen.getByText("Unrelated update"));
    expect(fixture.renderSidebar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Navigation update"));
    expect(fixture.renderSidebar).toHaveBeenCalledOnce();
  });
});
