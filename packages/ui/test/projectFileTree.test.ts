// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import type {
  IRemoteProjectService,
  ProjectSidebarProps,
  RemoteProjectHost,
  VirtualProject,
  ProjectTask,
} from "@/project-sidebar/contract.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
const onOpenFileManager = vi.fn();
afterEach(() => {
  onOpenFileManager.mockClear();
  useRemoteWorkspaceSessionStore.setState({
    sessionsById: {},
    sessionIdByWorkspaceIdentity: {},
    sessionIdByWorkspacePath: {},
  });
});
const remoteHost: RemoteProjectHost = {
  id: "remote:server:s",
  membershipId: "member",
  kind: "server",
  target: { kind: "server", url: "https://source.test" },
  position: 0,
};
const remoteProject: VirtualProject = {
  id: "remote-project",
  hostId: remoteHost.id,
  name: "Remote project",
  nameOverridden: false,
  roots: [
    { rootPath: "/one", position: 0, isPrimary: true },
    { rootPath: "/two", position: 1, isPrimary: false },
  ],
  position: 0,
  pinned: false,
  deleted: false,
  createdAt: 0,
  updatedAt: 0,
};
const remoteDirectory = { hosts: [remoteHost], entries: [] };

function deferredConnection() {
  const requested = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<string>();
  return {
    requested: requested.promise,
    complete: completion.resolve,
    connect: () => {
      requested.resolve();
      return completion.promise;
    },
  };
}

function remoteFileTreeSetup(connect: ProjectSidebarProps["onConnectRemote"]) {
  const connectHost = vi.fn(async () => remoteHost);
  const onConnectRemote = vi.fn(connect);
  const onCancelRemoteProject = vi.fn(async () => {});
  const onSelectRemoteProject = vi.fn<ProjectSidebarProps["onSelectRemoteProject"]>(
    async (sessionId, workspacePath, _localWorkspacePath, workspaceIdentity) => {
      useRemoteWorkspaceSessionStore.getState().registerSession({
        sessionId,
        workspacePath,
        workspaceIdentity,
        services: {},
      } as RemoteWorkspaceSession);
    },
  );
  return {
    props: {
      workspacePath: "/current",
      onOpenFileManager,
      onConnectRemote,
      onSelectRemoteProject,
      onCancelRemoteProject,
    } as unknown as ProjectSidebarProps,
    remoteService: { connectHost } as unknown as IRemoteProjectService,
    connectHost,
    onConnectRemote,
    onSelectRemoteProject,
    onCancelRemoteProject,
  };
}

it("keeps the newer file target when its remote connector completes first", async () => {
  const older = deferredConnection();
  const newer = deferredConnection();
  const connect = vi
    .fn<ProjectSidebarProps["onConnectRemote"]>()
    .mockImplementationOnce(older.connect)
    .mockImplementationOnce(newer.connect);
  const setup = remoteFileTreeSetup(connect);
  const { result } = renderHook(() =>
    useProjectFileTree(setup.props, remoteDirectory, setup.remoteService),
  );
  // 原因：必须让真实 connector 已进入等待，再发下一轮，才能覆盖 generation 的乱序结果保护。
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = result.current.openFiles(remoteProject, "/one");
    await older.requested;
  });
  await act(async () => {
    second = result.current.openFiles(remoteProject, "/two");
    await newer.requested;
  });
  expect(setup.connectHost.mock.calls).toEqual([["remote:server:s"], ["remote:server:s"]]);
  expect(setup.onConnectRemote.mock.calls).toEqual([[remoteHost.target], [remoteHost.target]]);
  expect(setup.onSelectRemoteProject).not.toHaveBeenCalled();
  expect(onOpenFileManager).not.toHaveBeenCalled();
  await act(async () => {
    newer.complete("newer-session");
    await second;
  });
  expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/two",
    workspaceName: "Remote project",
    workspaceIdentity: "remote:server:s:/two",
    workspaceRemoteSessionId: "newer-session",
  });
  await act(async () => {
    older.complete("older-session");
    await first;
  });
  expect(setup.onSelectRemoteProject.mock.calls).toEqual([
    ["newer-session", "/two", undefined, "remote:server:s:/two"],
    ["older-session", "/one", undefined, "remote:server:s:/one"],
  ]);
  expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/two",
    workspaceName: "Remote project",
    workspaceIdentity: "remote:server:s:/two",
    workspaceRemoteSessionId: "newer-session",
  });
  expect(setup.onCancelRemoteProject).not.toHaveBeenCalled();
});

it("consumes each open request once without reopening on rerender", () => {
  const target = { workspacePath: "/example", workspaceName: "Example" };
  const props = {
    onOpenFileManager,
    fileTreeOpenRequest: { id: 1, target },
  } as unknown as ProjectSidebarProps;
  const { rerender } = renderHook(
    (value) => useProjectFileTree(value, { hosts: [], entries: [] }),
    { initialProps: props },
  );
  rerender({ ...props });
  expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith(target);
  rerender({ ...props, fileTreeOpenRequest: { id: 2, target } });
  expect(onOpenFileManager).toHaveBeenCalledTimes(2);
});

it("opens pinned task cwd without a tab and never borrows a local remote session", async () => {
  const { result } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  await act(async () => {
    await result.current.openTaskFiles(
      { workspacePath: "/task-cwd", hostId: "local" } as ProjectTask,
      "wrong-remote",
    );
  });
  expect(onOpenFileManager).toHaveBeenLastCalledWith({
    workspacePath: "/task-cwd",
    workspaceName: "task-cwd",
  });
  await act(async () => {
    await expect(
      result.current.openTaskFiles({
        workspacePath: "/task-cwd",
        workspaceIdentity: "remote:missing",
        hostId: "remote-host",
      } as ProjectTask),
    ).rejects.toThrow("project.connection-unavailable");
  });
  expect(onOpenFileManager).toHaveBeenCalledTimes(1);
});

it("a late remote file connection cannot reopen an unmounted sidebar", async () => {
  const connection = deferredConnection();
  const setup = remoteFileTreeSetup(connection.connect);
  const { result, unmount } = renderHook(() =>
    useProjectFileTree(setup.props, remoteDirectory, setup.remoteService),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.openFiles(remoteProject, "/one");
    await connection.requested;
  });
  expect(setup.connectHost).toHaveBeenCalledExactlyOnceWith("remote:server:s");
  expect(setup.onConnectRemote).toHaveBeenCalledExactlyOnceWith(remoteHost.target);
  expect(setup.onSelectRemoteProject).not.toHaveBeenCalled();
  expect(onOpenFileManager).not.toHaveBeenCalled();
  // 原因：卸载只失效文件树请求；随后真实连接和身份绑定完成，也不能重新打开已关闭的视图。
  unmount();
  await act(async () => {
    connection.complete("late-session");
    await pending;
  });
  expect(setup.onSelectRemoteProject).toHaveBeenCalledExactlyOnceWith(
    "late-session",
    "/one",
    undefined,
    "remote:server:s:/one",
  );
  expect(onOpenFileManager).not.toHaveBeenCalled();
  expect(setup.onCancelRemoteProject).not.toHaveBeenCalled();
});

it("opens only the remote session matching the pinned task identity", async () => {
  useRemoteWorkspaceSessionStore.setState({
    sessionsById: {
      matching: {
        sessionId: "matching",
        workspaceIdentity: "remote:task",
      } as RemoteWorkspaceSession,
      other: { sessionId: "other", workspaceIdentity: "remote:other" } as RemoteWorkspaceSession,
    },
  });
  const { result } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  const task = {
    workspacePath: "/same-path",
    workspaceIdentity: "remote:task",
    hostId: "remote-host",
  } as ProjectTask;
  await act(async () => {
    await expect(result.current.openTaskFiles(task, "other")).rejects.toThrow(
      "project.connection-unavailable",
    );
  });
  expect(onOpenFileManager).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.openTaskFiles(task, "matching");
  });
  expect(onOpenFileManager).toHaveBeenLastCalledWith({
    workspacePath: "/same-path",
    workspaceName: "same-path",
    workspaceIdentity: "remote:task",
    workspaceRemoteSessionId: "matching",
  });
});

it("opens task files directly from the current window identity index", async () => {
  const state = useRemoteWorkspaceSessionStore.getState();
  state.registerSession({ sessionId: "fresh", services: {} } as RemoteWorkspaceSession);
  state.bindWorkspaceIdentity("remote:task", "fresh");
  const connect = vi.fn();
  const bind = vi.fn();
  const props = {
    onOpenFileManager,
    workspacePath: "/current",
    onConnectRemote: connect,
    onSelectRemoteProject: bind,
  } as unknown as ProjectSidebarProps;
  const { result } = renderHook(() => useProjectFileTree(props, { hosts: [], entries: [] }));
  await act(async () => {
    await result.current.openTaskFiles(
      {
        workspacePath: "/task",
        workspaceIdentity: "remote:task",
        hostId: "remote-host",
      } as ProjectTask,
      "stale",
    );
  });
  expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/task",
    workspaceName: "task",
    workspaceIdentity: "remote:task",
    workspaceRemoteSessionId: "fresh",
  });
  expect(connect).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});

it("rejects an unbound task identity without borrowing the current local path", async () => {
  useRemoteWorkspaceSessionStore.setState({
    sessionsById: {
      local: { sessionId: "local", workspacePath: "/task", services: {} } as RemoteWorkspaceSession,
    },
    sessionIdByWorkspacePath: { "/task": "local" },
  });
  const { result } = renderHook(() =>
    useProjectFileTree(
      { workspacePath: "/task", onOpenFileManager } as unknown as ProjectSidebarProps,
      { hosts: [], entries: [] },
    ),
  );
  await act(async () => {
    await expect(
      result.current.openTaskFiles({
        workspacePath: "/task",
        workspaceIdentity: "remote:task",
        hostId: "remote-host",
      } as ProjectTask),
    ).rejects.toThrow("project.connection-unavailable");
  });
  expect(onOpenFileManager).not.toHaveBeenCalled();
});

it("accepts an identity-bound mobile session without duplicated session metadata", async () => {
  const state = useRemoteWorkspaceSessionStore.getState();
  state.registerSession({ sessionId: "mobile", services: {} } as RemoteWorkspaceSession);
  state.bindWorkspaceIdentity("remote:task", "mobile");
  const { result } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  await act(async () => {
    await result.current.openTaskFiles({
      taskId: "task",
      hostId: "remote-host",
      workspacePath: "/same-path",
      workspaceIdentity: "remote:task",
    } as ProjectTask);
  });
  expect(onOpenFileManager).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceRemoteSessionId: "mobile" }),
  );
});
