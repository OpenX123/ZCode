import { expect, it, vi } from "vitest";
import { resolveProjectFileTarget } from "@/project-sidebar/project-file-navigation.js";
const project = {
  id: "p",
  hostId: "local",
  name: "Project",
  roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
};
it("opens a local root without preparing a task or connecting a host", async () => {
  const connect = vi.fn();
  const result = await resolveProjectFileTarget({
    project,
    rootPath: "/repo",
    isRemote: false,
    props: { onConnectRemote: connect },
    findSession: () => undefined,
  } as never);
  expect(result).toEqual({ workspacePath: "/repo", workspaceName: "Project" });
  expect(connect).not.toHaveBeenCalled();
});
it("uses a matching remote attachment and never borrows the same local path", async () => {
  const connect = vi.fn();
  const findSession = vi.fn((identity) =>
    identity === "remote:server:s:/repo" ? { sessionId: "remote-session" } : undefined,
  );
  const result = await resolveProjectFileTarget({
    project: { ...project, hostId: "remote:server:s" },
    rootPath: "/repo",
    isRemote: true,
    props: {
      workspacePath: "/repo",
      workspaceRemoteSessionId: "local-session",
      onConnectRemote: connect,
    },
    findSession,
  } as never);
  expect(result).toEqual({
    workspacePath: "/repo",
    workspaceName: "Project",
    workspaceIdentity: "remote:server:s:/repo",
    workspaceRemoteSessionId: "remote-session",
  });
  expect(findSession).toHaveBeenCalledExactlyOnceWith("remote:server:s:/repo");
  expect(connect).not.toHaveBeenCalled();
});
it("returns an identity-bound target without a desktop connector", async () => {
  const connect = vi.fn();
  const bind = vi.fn();
  const cancel = vi.fn();
  const findSession = vi.fn((identity) =>
    identity === "remote:server:s:/repo" ? { sessionId: "bound-session" } : undefined,
  );
  const result = await resolveProjectFileTarget({
    project: { ...project, hostId: "remote:server:s" },
    rootPath: "/repo",
    isRemote: true,
    props: {
      workspacePath: "/current",
      onConnectRemote: connect,
      onSelectRemoteProject: bind,
      onCancelRemoteProject: cancel,
    },
    findSession,
  } as never);
  expect(result).toEqual({
    workspacePath: "/repo",
    workspaceName: "Project",
    workspaceIdentity: "remote:server:s:/repo",
    workspaceRemoteSessionId: "bound-session",
  });
  expect(findSession).toHaveBeenCalledExactlyOnceWith("remote:server:s:/repo");
  expect(connect).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
it("rejects an unbound identity without a connector instead of borrowing the local path", async () => {
  const connect = vi.fn();
  const bind = vi.fn();
  const cancel = vi.fn();
  const findSession = vi.fn(() => undefined);
  await expect(
    resolveProjectFileTarget({
      project: { ...project, hostId: "remote:server:s" },
      rootPath: "/repo",
      isRemote: true,
      props: {
        workspacePath: "/repo",
        workspaceRemoteSessionId: "local-session",
        onConnectRemote: connect,
        onSelectRemoteProject: bind,
        onCancelRemoteProject: cancel,
      },
      findSession,
    } as never),
  ).rejects.toThrow("project.connection-unavailable");
  expect(findSession).toHaveBeenCalledExactlyOnceWith("remote:server:s:/repo");
  expect(connect).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});

it.each([false, true])(
  "rejects a foreign root before lookup or connection side effects (remote: %s)",
  async (isRemote) => {
    const connect = vi.fn();
    const bind = vi.fn();
    const cancel = vi.fn();
    const connectHost = vi.fn();
    const findSession = vi.fn();
    await expect(
      resolveProjectFileTarget({
        project: { ...project, hostId: isRemote ? "remote:server:s" : "local" },
        rootPath: "/other",
        isRemote,
        props: {
          onConnectRemote: connect,
          onSelectRemoteProject: bind,
          onCancelRemoteProject: cancel,
        },
        remoteService: { connectHost },
        findSession,
      } as never),
    ).rejects.toThrow("project.root-not-found");
    expect(findSession).not.toHaveBeenCalled();
    expect(connectHost).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  },
);

it("binds an unopened remote root through its existing host connector", async () => {
  let bound = false;
  const bind = vi.fn(async () => {
    bound = true;
  });
  const connectHost = vi.fn(async () => ({
    id: "remote:server:s",
    target: { kind: "server", url: "https://source.test" },
  }));
  const connect = vi.fn(async () => "attached");
  const cancel = vi.fn();
  const result = await resolveProjectFileTarget({
    project: { ...project, hostId: "remote:server:s" },
    rootPath: "/repo",
    isRemote: true,
    props: {
      onConnectRemote: connect,
      onSelectRemoteProject: bind,
      onCancelRemoteProject: cancel,
    },
    remoteService: { connectHost },
    findSession: () => (bound ? { sessionId: "attached" } : undefined),
  } as never);
  expect(connectHost).toHaveBeenCalledExactlyOnceWith("remote:server:s");
  expect(connect).toHaveBeenCalledExactlyOnceWith({ kind: "server", url: "https://source.test" });
  expect(bind).toHaveBeenCalledExactlyOnceWith(
    "attached",
    "/repo",
    undefined,
    "remote:server:s:/repo",
  );
  expect(result).toEqual({
    workspacePath: "/repo",
    workspaceName: "Project",
    workspaceIdentity: "remote:server:s:/repo",
    workspaceRemoteSessionId: "attached",
  });
  expect(cancel).not.toHaveBeenCalled();
});
