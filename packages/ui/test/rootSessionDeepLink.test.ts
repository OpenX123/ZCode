// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRemoteWorkspaceIdentity, type IPlatformService } from "@zcode/shared";
import type { SessionLocator } from "@zcode/shared/session-navigation";
import type { IServiceAccessor } from "@zcode/services";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

vi.mock("@/hooks/useServices.js", () => ({ useComposerClientNamespace: () => "desktop" }));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { activeTabId: null; tabs: never[] }) => unknown) =>
    selector({ activeTabId: null, tabs: [] }),
}));

function harness() {
  const callbacks = new Set<(target: SessionLocator) => void>();
  const queued: SessionLocator[] = [];
  const getTaskMeta = vi.fn();
  const services = { zcodeTaskService: { getTaskMeta } } as unknown as IServiceAccessor;
  const event = () => vi.fn(() => () => {});
  const platform = {
    onOpenSession: vi.fn((callback: (target: SessionLocator) => void) => {
      callbacks.add(callback);
      while (queued.length) callback(queued.shift()!);
      return () => {
        callbacks.delete(callback);
      };
    }),
    onFocusTab: event(),
    onNewTab: event(),
    onNewTask: event(),
    onOpenWorkspace: event(),
    onOpenWorkspacePath: event(),
    onTaskNotificationClick: event(),
    syncWindowTabs: vi.fn(),
    syncActiveTaskSession: vi.fn(),
    setApplicationLocale: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPlatformService;
  const addTab = vi.fn();
  const setWorkspaceActionError = vi.fn();
  const startDraftInWorkspace = vi.fn();
  const props = {
    platform,
    services,
    addTab,
    setWorkspaceActionError,
    startDraftInWorkspace,
    canBootstrapInitialWorkspace: false,
    setIsBootstrappingInitialWorkspace: vi.fn(),
    activateTabByPath: vi.fn().mockReturnValue(false),
    startNewTaskFromActiveWorkspace: vi.fn(),
    openWorkspace: vi.fn(),
    openWorkspacePath: vi.fn(),
    isDesktop: true,
    locale: "zh-CN" as const,
    tabs: [],
  };
  return {
    props,
    getTaskMeta,
    addTab,
    setWorkspaceActionError,
    startDraftInWorkspace,
    emit: (target: SessionLocator) => {
      if (!callbacks.size) queued.push(target);
      else for (const callback of callbacks) callback(target);
    },
  };
}

beforeEach(() => {
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
  useRemoteWorkspaceSessionStore.setState({
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
});
afterEach(cleanup);

describe("会话深度链接 renderer 导航", () => {
  it("完整恢复之前保留冷启动请求；精确查询成功后才激活既有会话", async () => {
    const h = harness();
    const target = { taskId: "existing", workspacePath: "/project" };
    let resolveMeta!: (value: unknown) => void;
    h.getTaskMeta.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve;
        }),
    );
    const hook = renderHook(
      ({ restored }) =>
        useRootPlatformEffects({ ...h.props, hasCompletedFullTabRestore: restored }),
      { initialProps: { restored: false } },
    );
    act(() => h.emit(target));
    expect(h.props.platform.onOpenSession).not.toHaveBeenCalled();
    expect(h.getTaskMeta).not.toHaveBeenCalled();
    hook.rerender({ restored: true });
    await waitFor(() => expect(h.getTaskMeta).toHaveBeenCalledWith(target));
    expect(h.addTab).not.toHaveBeenCalled();
    await act(async () => {
      resolveMeta(target);
    });
    await waitFor(() =>
      expect(h.addTab).toHaveBeenCalledWith(target.workspacePath, {
        workspaceIdentity: undefined,
        remoteSessionId: undefined,
      }),
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(target.workspacePath).activeTaskId,
    ).toBe(target.taskId);
    expect(Object.values(useWorkbenchTabsStore.getState().tabs)[0]?.sessionId).toBe(target.taskId);
    expect(h.startDraftInWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { taskId: "other", workspacePath: "/project" },
    { taskId: "existing", workspacePath: "/other" },
  ])("不存在或返回坐标不匹配时不创建空页签：%j", async (meta) => {
    const h = harness();
    h.getTaskMeta.mockResolvedValue(meta);
    renderHook(() => useRootPlatformEffects(h.props));
    act(() => h.emit({ taskId: "existing", workspacePath: "/project" }));
    await waitFor(() =>
      expect(h.setWorkspaceActionError).toHaveBeenCalledWith(expect.stringContaining("不存在")),
    );
    expect(h.addTab).not.toHaveBeenCalled();
    expect(h.startDraftInWorkspace).not.toHaveBeenCalled();
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(0);
  });

  it("远端同路径不同 Host 始终按完整 identity 选取权威服务", async () => {
    const h = harness();
    const path = "/project";
    const identityA = buildRemoteWorkspaceIdentity(path, {
      kind: "ssh",
      host: "a.invalid",
      username: "tester",
    });
    const identityB = buildRemoteWorkspaceIdentity(path, {
      kind: "ssh",
      host: "b.invalid",
      username: "tester",
    });
    const target = {
      taskId: "remote-task",
      workspacePath: path,
      workspaceIdentity: identityA,
      sourceServerId: "server-a",
    };
    const remoteA = vi.fn().mockResolvedValue(target);
    const remoteB = vi.fn();
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {
        a: {
          sessionId: "a",
          sourceServerId: "server-a",
          workspacePath: path,
          workspaceIdentity: identityA,
          services: { zcodeTaskService: { getTaskMeta: remoteA } } as unknown as IServiceAccessor,
        },
        b: {
          sessionId: "b",
          sourceServerId: "server-b",
          workspacePath: path,
          workspaceIdentity: identityB,
          services: { zcodeTaskService: { getTaskMeta: remoteB } } as unknown as IServiceAccessor,
        },
      },
      sessionIdByWorkspacePath: { [path]: "b" },
      sessionIdByWorkspaceIdentity: { [identityA]: "b", [identityB]: "b" },
    });
    renderHook(() => useRootPlatformEffects(h.props));
    act(() => h.emit(target));
    await waitFor(() =>
      expect(h.addTab).toHaveBeenCalledWith(path, {
        workspaceIdentity: identityA,
        remoteSessionId: "a",
      }),
    );
    expect(remoteA).toHaveBeenCalledWith(target);
    expect(remoteB).not.toHaveBeenCalled();
    expect(h.getTaskMeta).not.toHaveBeenCalled();
  });

  it.each(["offline", "source-mismatch", "source-without-identity"])(
    "远端不可定位时解释原因，不回落到本机同路径：%s",
    async (mode) => {
      const h = harness();
      const identity = buildRemoteWorkspaceIdentity("/project", {
        kind: "ssh",
        host: "offline.invalid",
        username: "tester",
      });
      if (mode === "source-mismatch")
        useRemoteWorkspaceSessionStore.setState({
          sessionsById: {
            remote: {
              sessionId: "remote",
              sourceServerId: "other",
              workspaceIdentity: identity,
              workspacePath: "/project",
              services: h.props.services,
            },
          },
          sessionIdByWorkspaceIdentity: { [identity]: "remote" },
        });
      renderHook(() => useRootPlatformEffects(h.props));
      act(() =>
        h.emit({
          taskId: "remote-task",
          workspacePath: "/project",
          ...(mode === "source-without-identity" ? {} : { workspaceIdentity: identity }),
          ...(mode === "offline" ? {} : { sourceServerId: "requested" }),
        }),
      );
      await waitFor(() =>
        expect(h.setWorkspaceActionError).toHaveBeenCalledWith(expect.stringContaining("尚未连接")),
      );
      expect(h.getTaskMeta).not.toHaveBeenCalled();
      expect(h.addTab).not.toHaveBeenCalled();
    },
  );

  it("本机非远程 identity 可正常导航，不被误判为断线设备", async () => {
    const h = harness();
    const target = {
      taskId: "local-task",
      workspacePath: "/local",
      workspaceIdentity: "local-owner-id",
    };
    h.getTaskMeta.mockResolvedValue(target);
    renderHook(() => useRootPlatformEffects(h.props));
    act(() => h.emit(target));
    await waitFor(() =>
      expect(h.addTab).toHaveBeenCalledWith(target.workspacePath, {
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: undefined,
      }),
    );
    expect(h.getTaskMeta).toHaveBeenCalledWith(target);
  });

  it("索引调用失败显示实际错误；异步结果在卸载后不再导航", async () => {
    const h = harness();
    let resolveMeta!: (value: unknown) => void;
    h.getTaskMeta
      .mockImplementationOnce(() => Promise.reject(new Error("502 Bad Gateway")))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMeta = resolve;
          }),
      );
    const target = { taskId: "existing", workspacePath: "/project" };
    const hook = renderHook(() => useRootPlatformEffects(h.props));
    act(() => h.emit(target));
    await waitFor(() => expect(h.setWorkspaceActionError).toHaveBeenCalledWith("502 Bad Gateway"));
    act(() => h.emit(target));
    await waitFor(() => expect(h.getTaskMeta).toHaveBeenCalledTimes(2));
    hook.unmount();
    await act(async () => {
      resolveMeta(target);
    });
    expect(h.addTab).not.toHaveBeenCalled();
  });
});
