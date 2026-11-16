import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  HostMessageTypes,
  HostResponseTypes,
  InternalChannels,
  PlatformChannels,
  type RemoteTarget,
  ZCODE_VERSION,
} from "@zcode/shared";
import { createRemoteWorkspaceSessionManager } from "../src/main/desktopRemoteSessions.js";
import { ProviderProvisioningEnvironmentCoordinator } from "../src/main/providerProvisioningEnvironmentCoordinator.js";

const { browserWindowMock, channels } = vi.hoisted(() => {
  const windows: Array<unknown> = [];
  return {
    channels: [] as Array<{ port1: { close: ReturnType<typeof vi.fn> }; port2: object }>,
    browserWindowMock: {
      windows,
      fromId: vi.fn(
        (id: number) =>
          windows.find((candidate) => (candidate as { id: number }).id === id) ?? null,
      ),
      getAllWindows: vi.fn(() => windows),
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: browserWindowMock,
  MessageChannelMain: vi.fn(function MessageChannelMainMock() {
    const channel = {
      port1: {
        close: vi.fn(),
        start: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        postMessage: vi.fn(),
      },
      port2: {
        close: vi.fn(),
        start: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        postMessage: vi.fn(),
      },
    };
    channels.push(channel);
    return channel;
  }),
}));

class MockUtilityProcess extends EventEmitter {
  pid: number;
  postMessage: ReturnType<typeof vi.fn>;
  autoProvisioning = true;
  provisioningResult: {
    status: "applied" | "already-applied" | "unsupported" | "failed" | "rollback_failed";
    error?: string;
    errorCode?: string;
  } = { status: "applied" };

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.postMessage = vi.fn((message: unknown) => {
      const candidate = message as {
        type?: string;
        requestId?: string;
        environmentKey?: string;
      };
      if (candidate.type !== HostMessageTypes.ProviderProvisioningExecute || !this.autoProvisioning)
        return;
      queueMicrotask(() => {
        this.emit("message", {
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: candidate.requestId,
          environmentKey: candidate.environmentKey,
          ...this.provisioningResult,
        });
      });
    });
  }
}

const scopedPortEvents = new EventEmitter();

function createWindow(id: number, webContentsId: number) {
  const win = {
    id,
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isDestroyed: () => false,
      send: vi.fn(),
      postMessage: vi.fn((channel: string, payload: { sessionId: string }, _ports?: unknown[]) => {
        if (channel === InternalChannels.ScopedServicePort) scopedPortEvents.emit("port", payload);
      }),
    },
  };
  browserWindowMock.windows.push(win);
  return win;
}

const sshTarget: RemoteTarget = {
  kind: "ssh",
  host: "dev.internal",
  username: "developer",
};

function createManager(
  windowHostProcessMap: Map<number, MockUtilityProcess>,
  options?: {
    rendererAttachmentReadyTimeoutMs?: number;
    workspaceBindReadyTimeoutMs?: number;
    monotonicNowMs?: () => number;
    providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
    resolveWslTarget?: (
      target: Extract<RemoteTarget, { kind: "wsl" }>,
    ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
    logger?: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  },
) {
  return createRemoteWorkspaceSessionManager({
    logger: options?.logger ?? { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    windowHostProcessMap: windowHostProcessMap as never,
    resolveRemoteAssetDirs: () => ({}),
    resolveWslTarget: options?.resolveWslTarget,
    rendererAttachmentReadyTimeoutMs: options?.rendererAttachmentReadyTimeoutMs,
    workspaceBindReadyTimeoutMs: options?.workspaceBindReadyTimeoutMs,
    monotonicNowMs: options?.monotonicNowMs,
    providerProvisioningCoordinator: options?.providerProvisioningCoordinator,
  });
}

async function emitConnected(params: {
  child: MockUtilityProcess;
  requestId: string;
  remoteSessionId: string;
  sourceServerId?: string;
  reusedConnectionTarget?: RemoteTarget;
  target?: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: "project" | "conversation";
  waitForAttachment?: boolean;
}) {
  const target = params.target ?? sshTarget;
  const workspacePath = params.workspacePath ?? "/";
  const shouldWaitForAttachment =
    params.child.autoProvisioning &&
    params.waitForAttachment !== false &&
    ["applied", "already-applied"].includes(params.child.provisioningResult.status) &&
    !browserWindowMock.windows.some((candidate) =>
      (candidate as ReturnType<typeof createWindow>).webContents.postMessage.mock.calls.some(
        ([channel, payload]) =>
          channel === InternalChannels.ScopedServicePort &&
          payload.sessionId === params.remoteSessionId,
      ),
    );
  const attachmentPublished = shouldWaitForAttachment
    ? new Promise<void>((resolve) => {
        const onPort = (payload: { sessionId: string }) => {
          if (payload.sessionId !== params.remoteSessionId) return;
          scopedPortEvents.off("port", onPort);
          resolve();
        };
        scopedPortEvents.on("port", onPort);
      })
    : undefined;
  params.child.emit("message", {
    type: HostResponseTypes.RemoteWorkspaceConnected,
    requestId: params.requestId,
    descriptor: {
      ...(params.sourceServerId ? { sourceServerId: params.sourceServerId } : {}),
      ...(params.reusedConnectionTarget
        ? { reusedConnectionTarget: params.reusedConnectionTarget }
        : {}),
      remoteSessionId: params.remoteSessionId,
      target,
      workspacePath,
      workspaceIdentity:
        params.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, target),
      ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
      generation: 1,
    },
  });
  // 实际端口发布事件推进首次同步链，不猜微任务数量，也不推进 fake timer 越过原 ACK 截止。
  await attachmentPublished;
}

function getLatestScopedAttachment(win: ReturnType<typeof createWindow>): {
  attachmentId: string;
  sessionId: string;
} {
  const call = win.webContents.postMessage.mock.calls.findLast(
    ([channel]) => channel === InternalChannels.ScopedServicePort,
  );
  expect(call).toBeDefined();
  return call?.[1] as { attachmentId: string; sessionId: string };
}

function confirmLatestScopedAttachment(
  manager: ReturnType<typeof createManager>,
  win: ReturnType<typeof createWindow>,
): void {
  const payload = getLatestScopedAttachment(win);
  manager.confirmRendererAttachmentReady(win.webContents.id, payload);
}

// 各组都复用窗口 ID；只在首组清理会让后续 bind 把新 attachment 发给上一组的旧窗口。
beforeEach(() => {
  browserWindowMock.windows.length = 0;
  channels.length = 0;
  scopedPortEvents.removeAllListeners();
  browserWindowMock.fromId.mockClear();
  browserWindowMock.getAllWindows.mockClear();
});

describe("desktopRemoteSessions R1 window Host forwarding", () => {
  it("按 requestId 把窗口 Host 的远程连接进度转发给发起连接的 renderer", () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    void manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    win.webContents.send.mockClear();

    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnectionLog,
      requestId: "connect-1",
      level: "info",
      message: "detecting remote env...",
    });

    expect(win.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.RemoteConnectionLog,
      expect.objectContaining({
        requestId: "connect-1",
        level: "info",
        message: "detecting remote env...",
        timestamp: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/u),
      }),
    );
  });

  it("按当前请求返回在线复用信息，等待 desktop-continuous attachment 就绪后才通知", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const onConnected = vi.fn();
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "reuse",
      undefined,
      { onConnected },
    );
    await emitConnected({
      child,
      requestId: "reuse",
      remoteSessionId: "session-reused",
      reusedConnectionTarget: sshTarget,
    });
    expect(onConnected).not.toHaveBeenCalled();
    confirmLatestScopedAttachment(manager, win);
    await expect(connecting).resolves.toBe("session-reused");
    expect(onConnected).toHaveBeenCalledWith(
      expect.objectContaining({ reusedConnectionTarget: sshTarget }),
    );
  });

  it("缓存恢复 Host 失败 reply 经 Main 保留严格 locator，仍按原 request owner 拒绝", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const cacheRecovery = {
      kind: "source-server-cache-lock",
      version: ZCODE_VERSION,
      target: "linux-x64",
      sha256: "a".repeat(64),
    };
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "cache-recovery",
    );
    const assertion = expect(connecting).rejects.toMatchObject({
      code: "source-server-cache-lock-interrupted",
      retryable: false,
      cacheRecovery,
    });
    await vi.waitFor(() =>
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: HostMessageTypes.ConnectRemoteWorkspace,
          requestId: "cache-recovery",
        }),
      ),
    );
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnectFailed,
      requestId: "cache-recovery",
      error: "safe failure",
      reasonCode: "source-server-cache-lock-interrupted",
      retryable: false,
      cacheRecovery,
    });
    await assertion;
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it.each(["source-server-upgrade-required", "source-server-install-required"])(
    "WSL 参数补全后的 %s 保留实际 Profile 和安装目标",
    async (reasonCode) => {
      const child = new MockUtilityProcess(1001);
      const win = createWindow(1, 101);
      const resolvedTarget = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;
      const manager = createManager(new Map([[101, child]]), {
        resolveWslTarget: async () => resolvedTarget,
      });
      const connecting = manager.createRemoteWorkspaceSession(
        win as never,
        { kind: "wsl" },
        "wsl-upgrade",
      );
      const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
      const resolved = { resolvedWslTarget: resolvedTarget };
      const assertion = expect(connecting).rejects.toMatchObject({
        code: reasonCode,
        retryable: false,
        profileId,
        ...resolved,
      });
      await vi.waitFor(() =>
        expect(child.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: HostMessageTypes.ConnectRemoteWorkspace,
            target: resolvedTarget,
          }),
        ),
      );
      child.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceConnectFailed,
        requestId: "wsl-upgrade",
        error: "upgrade required",
        reasonCode,
        retryable: false,
        profileId,
        ...resolved,
      });
      await assertion;
      manager.disposeRemoteWorkspaceSessionsForWindow(101);
    },
  );

  it("连接请求发给窗口唯一 Local Host，成功后由同一进程暴露 remote-scoped port", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));

    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: "connect-1",
        target: sshTarget,
      }),
    );

    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });

    let connectionSettled = false;
    void connecting.then(() => {
      connectionSettled = true;
    });
    await Promise.resolve();
    expect(connectionSettled).toBe(false);
    confirmLatestScopedAttachment(manager, win);
    await expect(connecting).resolves.toBe("remote-session-1");
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.AttachServicePort,
        clientMode: "desktop-continuous",
        scope: expect.objectContaining({
          kind: "remote",
          remoteSessionId: "remote-session-1",
          workspaceIdentity: buildRemoteWorkspaceIdentity("/", sshTarget),
        }),
      }),
      expect.any(Array),
    );
    expect(win.webContents.postMessage).toHaveBeenCalledWith(
      InternalChannels.ScopedServicePort,
      expect.objectContaining({
        attachmentId: expect.any(String),
        sessionId: "remote-session-1",
        target: sshTarget,
        workspacePath: "/",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/", sshTarget),
      }),
      expect.any(Array),
    );
  });

  it.each(["failed", "rollback_failed", "unsupported"] as const)(
    "首次 Provisioning 返回 %s 时拒绝连接且不发布 Renderer port",
    async (status) => {
      const child = new MockUtilityProcess(1001);
      child.provisioningResult = { status, error: "sync unavailable" };
      const win = createWindow(1, 101);
      const manager = createManager(new Map([[101, child]]));

      const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
      await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });

      await expect(connecting).rejects.toThrow(/Provider Provisioning/u);
      expect(win.webContents.postMessage).not.toHaveBeenCalledWith(
        InternalChannels.ScopedServicePort,
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("首次 Provisioning 尚未返回时不发布 Desktop，成功后仍等待 renderer ACK", async () => {
    const child = new MockUtilityProcess(1001);
    child.autoProvisioning = false;
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const settled = vi.fn();
    const connecting = manager
      .createRemoteWorkspaceSession(win as never, sshTarget, "first-provisioning")
      .then(settled);
    await emitConnected({
      child,
      requestId: "first-provisioning",
      remoteSessionId: "first-session",
    });
    expect(win.webContents.postMessage).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    const command = child.postMessage.mock.calls.find(
      ([message]) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )![0];
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: command.requestId,
      environmentKey: command.environmentKey,
      status: "applied",
    });
    await vi.waitFor(() => expect(getLatestScopedAttachment(win).sessionId).toBe("first-session"));
    expect(settled).not.toHaveBeenCalled();
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    expect(settled).toHaveBeenCalledWith("first-session");
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it("已连接后的 Provisioning 失败只记录结构化 warning，不拆除 Workspace", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = createManager(new Map([[101, child]]), { logger });
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    child.provisioningResult = { status: "failed", error: "token=secret-value" };
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningSourceChanged,
      trigger: "personal-config",
    });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());

    expect(logger.warn).toHaveBeenCalledWith(
      "[provider-provisioning] Environment sync did not apply",
      expect.objectContaining({
        environmentKey: expect.any(String),
        trigger: "personal-config",
        status: "failed",
      }),
    );
    expect(logger.warn.mock.calls.at(-1)?.[1]).not.toHaveProperty("errorSummary");
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(true);
  });

  it.each([undefined, "source-read-failed"])(
    "首次同步失败把安全错误码 %s 写入日志和连接面板，不泄漏自由文本",
    async (errorCode) => {
      const child = new MockUtilityProcess(1001);
      child.provisioningResult = { status: "failed", error: "token=fixture-secret", errorCode };
      const win = createWindow(1, 101);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const manager = createManager(new Map([[101, child]]), { logger });
      const connecting = manager.createRemoteWorkspaceSession(
        win as never,
        sshTarget,
        "connect-diagnostic",
      );
      const outcome = connecting.catch((error: Error) => error.message);
      await emitConnected({
        child,
        requestId: "connect-diagnostic",
        remoteSessionId: "remote-diagnostic",
      });
      await outcome;
      const code = errorCode ?? "target-apply-failed";
      expect(logger.warn).toHaveBeenCalledWith(
        "[provider-provisioning] Environment sync did not apply",
        expect.objectContaining({
          trigger: "environment-online",
          status: "failed",
          errorCode: code,
        }),
      );
      expect(await outcome).toContain(code);
      expect(win.webContents.send).toHaveBeenCalledWith(
        PlatformChannels.RemoteConnectionLog,
        expect.objectContaining({
          requestId: "connect-diagnostic",
          level: "error",
          message: expect.stringContaining(code),
        }),
      );
      expect(
        JSON.stringify([logger.warn.mock.calls, win.webContents.send.mock.calls, await outcome]),
      ).not.toContain("fixture-secret");
      expect(win.webContents.postMessage).not.toHaveBeenCalled();
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: HostMessageTypes.DisposeRemoteWorkspaceSession }),
      );
    },
  );

  it("连接只有对应窗口与 attachment 的 renderer ACK 后才完成", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const settled = vi.fn();
    const connecting = manager
      .createRemoteWorkspaceSession(win as never, sshTarget, "connect-ready")
      .then(settled);
    await emitConnected({ child, requestId: "connect-ready", remoteSessionId: "remote-ready" });
    const attachment = getLatestScopedAttachment(win);
    manager.confirmRendererAttachmentReady(202, attachment);
    manager.confirmRendererAttachmentReady(101, { ...attachment, attachmentId: "old-attachment" });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.postMessage).not.toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: attachment.attachmentId,
    });
    manager.confirmRendererAttachmentReady(101, attachment);
    await connecting;
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("remote-ready");
    manager.disposeRemoteWorkspaceSession("remote-ready");
  });

  it("连接异常关闭后停止 attachment，随后 dispose 幂等回收同一 session", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    const attachment = getLatestScopedAttachment(win);
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "remote-session-1",
      reason: "connection-closed",
      exitCode: 255,
      signal: null,
    });
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: attachment.attachmentId,
    });
    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed-again");
    expect(
      child.postMessage.mock.calls.filter(
        ([message]) => message.type === HostMessageTypes.DisposeRemoteWorkspaceSession,
      ),
    ).toEqual([[expect.objectContaining({ remoteSessionId: "remote-session-1" })]]);
    expect(
      child.postMessage.mock.calls.filter(
        ([message]) => message.type === HostMessageTypes.DetachServicePort,
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["window-closed", "window"],
    ["host-exit", "host"],
    ["app-shutdown", "app"],
  ] as const)("%s 清除 route 后不再复挂或接受旧 ACK", async (_reason, owner) => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    const attachment = getLatestScopedAttachment(win);
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    if (owner === "window") manager.disposeRemoteWorkspaceSessionsForWindow(101);
    else if (owner === "host") child.emit("exit");
    else await manager.disposeAllAndWaitForAppShutdown("app-quit");
    win.webContents.postMessage.mockClear();
    child.postMessage.mockClear();
    manager.confirmRendererAttachmentReady(101, attachment);
    manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "late-reload");
    manager.disposeRemoteWorkspaceSession("remote-session-1");
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
    expect(win.webContents.postMessage).not.toHaveBeenCalled();
    expect(child.postMessage).not.toHaveBeenCalled();
  });

  it("同 target 的各 logical session 独立持有 scope，释放一个不影响另一个", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const targets: RemoteTarget[] = [
      sshTarget,
      sshTarget,
      { kind: "server", url: "ws://studio.example.com/ws" },
      { kind: "server", url: "http://studio.example.com" },
      { kind: "server", url: "wss://studio.example.com/ws" },
      { kind: "server", url: "https://studio.example.com" },
    ];
    const attachments: string[] = [];
    for (const [index, target] of targets.entries()) {
      const requestId = "connect-" + index;
      const remoteSessionId = "remote-" + index;
      const connecting = manager.createRemoteWorkspaceSession(win as never, target, requestId);
      await emitConnected({ child, requestId, remoteSessionId, target });
      expect(getLatestScopedAttachment(win).sessionId).toBe(remoteSessionId);
      attachments.push(getLatestScopedAttachment(win).attachmentId);
      confirmLatestScopedAttachment(manager, win);
      await expect(connecting).resolves.toBe(remoteSessionId);
    }
    expect(new Set(attachments).size).toBe(6);
    manager.disposeRemoteWorkspaceSession("remote-0");
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(true);
    const surviving = manager.attachRemoteWorkspaceSessionHost({
      windowId: 1,
      remoteSessionId: "remote-1",
      workspacePath: "/",
      workspaceIdentity: "remote:ssh:dev.internal:22:developer:/",
      workspaceKey: "remote:ssh:dev.internal:22:developer:/",
      clientMode: "web-remote-replayable",
    });
    expect(surviving.process).toBe(child);
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it("已 ready session 的显式 dispose 幂等拆除 attachment 并释放 Host scope", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    const attachment = getLatestScopedAttachment(win);
    confirmLatestScopedAttachment(manager, win);
    await expect(connecting).resolves.toBe("remote-session-1");
    child.postMessage.mockClear();
    expect(() => manager.disposeRemoteWorkspaceSession("remote-session-1")).not.toThrow();
    expect(() => manager.disposeRemoteWorkspaceSession("remote-session-1")).not.toThrow();
    expect(child.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: HostMessageTypes.DetachServicePort, attachmentId: attachment.attachmentId },
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      }),
    ]);
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
  });

  it("WSL target 解析期间进入 app shutdown 后不发送迟到连接", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    let resolveWslTarget!: (target: Extract<RemoteTarget, { kind: "wsl" }>) => void;
    const manager = createManager(new Map([[101, child]]), {
      resolveWslTarget: () =>
        new Promise((resolve) => {
          resolveWslTarget = resolve;
        }),
    });
    const target = { kind: "wsl", distro: "Ubuntu" } as const;
    const connecting = manager.createRemoteWorkspaceSession(win as never, target, "connect-wsl");
    await vi.waitFor(() => expect(resolveWslTarget).toBeTypeOf("function"));

    await manager.disposeAllAndWaitForAppShutdown("app-quit");
    const settled = connecting.catch((error: unknown) => error);
    resolveWslTarget(target);
    await Promise.resolve();

    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: HostMessageTypes.ConnectRemoteWorkspace }),
    );
    await expect(settled).resolves.toMatchObject({
      message: expect.stringContaining("应用正在退出"),
    });
  });

  it("两个窗口的连接、descriptor 和 attachment 都发往各自 Local Host", async () => {
    const firstChild = new MockUtilityProcess(1001);
    const secondChild = new MockUtilityProcess(1002);
    const firstWindow = createWindow(1, 101);
    const secondWindow = createWindow(2, 202);
    const manager = createManager(
      new Map([
        [101, firstChild],
        [202, secondChild],
      ]),
    );

    const first = manager.createRemoteWorkspaceSession(
      firstWindow as never,
      sshTarget,
      "connect-first",
    );
    const second = manager.createRemoteWorkspaceSession(
      secondWindow as never,
      sshTarget,
      "connect-second",
    );
    await emitConnected({
      child: firstChild,
      requestId: "connect-first",
      remoteSessionId: "remote-first",
    });
    await emitConnected({
      child: secondChild,
      requestId: "connect-second",
      remoteSessionId: "remote-second",
    });
    confirmLatestScopedAttachment(manager, firstWindow);
    confirmLatestScopedAttachment(manager, secondWindow);

    await expect(first).resolves.toBe("remote-first");
    await expect(second).resolves.toBe("remote-second");
    expect(firstChild.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ remoteSessionId: "remote-second" }),
      }),
      expect.anything(),
    );
    expect(secondChild.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ remoteSessionId: "remote-first" }),
      }),
      expect.anything(),
    );
    const provisioningExecutions = [
      ...firstChild.postMessage.mock.calls,
      ...secondChild.postMessage.mock.calls,
    ].filter(
      ([message]) =>
        (message as { type?: string }).type === HostMessageTypes.ProviderProvisioningExecute,
    );
    expect(provisioningExecutions).toHaveLength(1);
  });

  it("取消 pending connection 只发控制消息，不退出窗口 Host", () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    void manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-cancel");

    manager.cancelPendingRemoteWorkspaceSessionsForWindow(101, "user-cancel", "connect-cancel");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.CancelRemoteWorkspaceConnect,
      requestId: "connect-cancel",
    });
  });

  it("绑定 canonical context 后先更新 Host，再重建 identity-validated renderer port", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      sourceServerId,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    const firstAttachmentId = getLatestScopedAttachment(win).attachmentId;
    child.postMessage.mockClear();

    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      {
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
      },
      101,
    );

    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity: `remote:server:${sourceServerId}:/work/demo`,
      legacyRouteHint: "remote:ssh:dev.internal:22:developer:/work/demo",
    });
    const bindRequest = child.postMessage.mock.calls[0]?.[0] as { requestId: string };
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBound,
      requestId: bindRequest.requestId,
      previousWorkspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
    });
    await Promise.resolve();
    expect(child.postMessage.mock.calls[1]?.[0]).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: `remote:server:${sourceServerId}:/work/demo`,
      },
    });
    expect(child.postMessage).not.toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: firstAttachmentId,
    });
    confirmLatestScopedAttachment(manager, win);
    await expect(binding).resolves.toEqual({
      sourceServerId,
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity: `remote:server:${sourceServerId}:/work/demo`,
      previousWorkspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
    });
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: firstAttachmentId,
    });
  });

  it("rejects bind before attaching a renderer port when Host workspace preparation fails", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      { workspacePath: "/work/demo" },
      101,
    );
    const request = child.postMessage.mock.calls[0]?.[0] as { requestId: string };
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
      requestId: request.requestId,
      error: "workspace migration conflict",
      reasonCode: "workspace-task-identity-conflict",
      retryable: false,
    });

    await expect(binding).rejects.toMatchObject({
      message: "workspace migration conflict",
      code: "workspace-task-identity-conflict",
      retryable: false,
    });
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: HostMessageTypes.AttachServicePort }),
      expect.anything(),
    );
  });

  it("rejects a pending workspace bind when its Window Host exits", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      { workspacePath: "/work/demo" },
      101,
    );
    child.emit("exit", 1);

    await expect(binding).rejects.toThrow("窗口 Local Host 已退出");
  });

  it("times out a workspace bind that receives no Host ACK", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockUtilityProcess(1001);
      const win = createWindow(1, 101);
      const manager = createManager(new Map([[101, child]]), {
        workspaceBindReadyTimeoutMs: 10,
      });
      const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
      await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
      confirmLatestScopedAttachment(manager, win);
      await connecting;
      child.postMessage.mockClear();

      const binding = manager.bindRemoteWorkspaceSessionContext(
        "remote-session-1",
        { workspacePath: "/work/demo" },
        101,
      );
      const rejection = expect(binding).rejects.toMatchObject({
        message: expect.stringContaining("workspace bind ACK 超时"),
        code: "remote-bind-canceled",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(10);

      await rejection;
      const bindMessage = child.postMessage.mock.calls.find(
        ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
      )?.[0];
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: HostMessageTypes.CancelRemoteWorkspaceBind,
          requestId: bindMessage.requestId,
          remoteSessionId: "remote-session-1",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins a duplicate connected response to the existing pending bind without orphaning its attachment", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockUtilityProcess(1001);
      const win = createWindow(1, 101);
      const manager = createManager(new Map([[101, child]]), {
        rendererAttachmentReadyTimeoutMs: 10,
      });
      const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
      await emitConnected({
        child,
        requestId: "connect-1",
        remoteSessionId: "remote-session-1",
        sourceServerId: "source-1",
      });
      confirmLatestScopedAttachment(manager, win);
      await connecting;

      const workspacePath = "/work/conversation";
      const workspaceIdentity = "remote:server:source-1:/work/conversation";
      const binding = manager.bindRemoteWorkspaceSessionContext(
        "remote-session-1",
        {
          workspacePath,
          workspaceIdentity,
          workspacePurpose: "conversation",
        },
        101,
      );
      const bindRequest = child.postMessage.mock.calls.find(
        ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
      )?.[0] as { requestId: string };
      child.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceContextBound,
        requestId: bindRequest.requestId,
      });
      await Promise.resolve();
      const bindingAttachment = getLatestScopedAttachment(win);

      const joined = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-2", {
        workspacePath,
        workspaceIdentity,
      });
      await emitConnected({
        child,
        requestId: "connect-2",
        remoteSessionId: "remote-session-1",
        sourceServerId: "source-1",
        workspacePath,
        workspaceIdentity,
        workspacePurpose: "conversation",
      });

      expect(
        win.webContents.postMessage.mock.calls.filter(
          ([channel]) => channel === InternalChannels.ScopedServicePort,
        ),
      ).toHaveLength(2);
      manager.confirmRendererAttachmentReady(win.webContents.id, bindingAttachment);
      await expect(binding).resolves.toMatchObject({
        remoteSessionId: "remote-session-1",
        workspaceIdentity,
      });
      await expect(joined).resolves.toBe("remote-session-1");

      await vi.advanceTimersByTimeAsync(10);
      expect(child.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          remoteSessionId: "remote-session-1",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a joined connect pending until the matching context bind becomes renderer-ready", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    const workspacePath = "/work/conversation";
    const workspaceIdentity = "remote:server:source-1:/work/conversation";
    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      {
        workspacePath,
        workspaceIdentity,
        workspacePurpose: "conversation",
      },
      101,
    );
    const joined = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-2", {
      workspacePath,
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-2",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
      workspacePath,
      workspaceIdentity,
      workspacePurpose: "conversation",
    });
    const joinedBeforeBindReady = await Promise.race([
      joined.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(joinedBeforeBindReady).toBe("pending");

    const bindRequest = child.postMessage.mock.calls.find(
      ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
    )?.[0] as { requestId: string };
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBound,
      requestId: bindRequest.requestId,
    });
    await Promise.resolve();
    confirmLatestScopedAttachment(manager, win);
    await expect(binding).resolves.toMatchObject({ workspaceIdentity });
    await expect(joined).resolves.toBe("remote-session-1");
  });

  it("shares one workspace bind flight for the same session context", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    const context = {
      workspacePath: "/work/conversation",
      workspaceIdentity: "remote:server:source-1:/work/conversation",
      workspacePurpose: "conversation" as const,
    };
    const first = manager.bindRemoteWorkspaceSessionContext("remote-session-1", context, 101);
    const second = manager.bindRemoteWorkspaceSessionContext("remote-session-1", context, 101);
    const bindMessages = child.postMessage.mock.calls.filter(
      ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
    );

    expect(bindMessages).toHaveLength(1);
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBound,
      requestId: bindMessages[0]?.[0].requestId,
      previousWorkspaceIdentity: "remote:ssh:legacy:/work/conversation",
    });
    await Promise.resolve();
    confirmLatestScopedAttachment(manager, win);
    await expect(first).resolves.toMatchObject({
      workspaceIdentity: context.workspaceIdentity,
      previousWorkspaceIdentity: "remote:ssh:legacy:/work/conversation",
    });
    await expect(second).resolves.toEqual(await first);
  });

  it("returns an already-ready identical workspace context without rotating the attachment", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    const context = {
      workspacePath: "/work/conversation",
      workspaceIdentity: "remote:server:source-1:/work/conversation",
      workspacePurpose: "conversation" as const,
    };
    const first = manager.bindRemoteWorkspaceSessionContext("remote-session-1", context, 101);
    const bindRequest = child.postMessage.mock.calls.find(
      ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
    )?.[0] as { requestId: string };
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBound,
      requestId: bindRequest.requestId,
    });
    await Promise.resolve();
    const attachment = getLatestScopedAttachment(win);
    manager.confirmRendererAttachmentReady(win.webContents.id, attachment);
    await first;
    child.postMessage.mockClear();
    win.webContents.postMessage.mockClear();

    const repeated = manager.bindRemoteWorkspaceSessionContext("remote-session-1", context, 101);

    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.BindRemoteWorkspaceContext,
      }),
    );
    expect(win.webContents.postMessage).not.toHaveBeenCalledWith(
      InternalChannels.ScopedServicePort,
      expect.anything(),
      expect.anything(),
    );
    await expect(repeated).resolves.toMatchObject({
      remoteSessionId: "remote-session-1",
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      workspacePurpose: "conversation",
    });
  });

  it("ready route 的同 scope join 复用原 attachment 并返回同 session", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const background = manager.createRemoteWorkspaceSession(win as never, sshTarget, "background");
    await emitConnected({ child, requestId: "background", remoteSessionId: "remote-session-1" });
    const attachment = getLatestScopedAttachment(win);
    confirmLatestScopedAttachment(manager, win);
    await background;
    const joined = manager.createRemoteWorkspaceSession(win as never, sshTarget, "joined");
    await emitConnected({ child, requestId: "joined", remoteSessionId: "remote-session-1" });
    await expect(joined).resolves.toBe("remote-session-1");
    expect(getLatestScopedAttachment(win)).toEqual(attachment);
    expect(win.webContents.postMessage).toHaveBeenCalledOnce();
    manager.disposeRemoteWorkspaceSession("remote-session-1");
  });

  it("rejects a concurrent different context without disturbing the owning bind", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    const owningContext = {
      workspacePath: "/work/conversation",
      workspaceIdentity: "remote:server:source-1:/work/conversation",
      workspacePurpose: "conversation" as const,
    };
    const owningBind = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      owningContext,
      101,
    );
    await expect(
      manager.bindRemoteWorkspaceSessionContext(
        "remote-session-1",
        {
          workspacePath: "/work/project",
          workspaceIdentity: "remote:server:source-1:/work/project",
          workspacePurpose: "project",
        },
        101,
      ),
    ).rejects.toThrow("正在绑定其它 context");

    const bindMessages = child.postMessage.mock.calls.filter(
      ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
    );
    expect(bindMessages).toHaveLength(1);
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBound,
      requestId: bindMessages[0]?.[0].requestId,
    });
    await Promise.resolve();
    confirmLatestScopedAttachment(manager, win);
    await expect(owningBind).resolves.toMatchObject({
      workspacePath: owningContext.workspacePath,
      workspaceIdentity: owningContext.workspaceIdentity,
    });
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      }),
    );
  });

  it("rejects a same-session join from a mismatched target without replacing the owner route", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const owner = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-owner");
    await emitConnected({
      child,
      requestId: "connect-owner",
      remoteSessionId: "remote-session-1",
    });
    confirmLatestScopedAttachment(manager, win);
    await owner;
    win.webContents.postMessage.mockClear();
    child.postMessage.mockClear();

    const otherTarget: RemoteTarget = {
      kind: "docker",
      container: "other-runtime",
    };
    const conflicting = manager.createRemoteWorkspaceSession(
      win as never,
      otherTarget,
      "connect-conflict",
    );
    await emitConnected({
      child,
      requestId: "connect-conflict",
      remoteSessionId: "remote-session-1",
      target: otherTarget,
      waitForAttachment: false,
    });

    await expect(conflicting).rejects.toThrow("join 与已有 route 不匹配");
    expect(win.webContents.postMessage).not.toHaveBeenCalledWith(
      InternalChannels.ScopedServicePort,
      expect.anything(),
      expect.anything(),
    );
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      }),
    );
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(true);
  });

  it("joins a different Profile request when Host returns the canonical Source owner target", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const owner = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-owner");
    await emitConnected({
      child,
      requestId: "connect-owner",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
    });
    confirmLatestScopedAttachment(manager, win);
    await owner;
    win.webContents.postMessage.mockClear();
    child.postMessage.mockClear();

    const alternateProfileTarget: RemoteTarget = {
      kind: "ssh",
      host: "route-b.internal",
      username: "developer",
    };
    const joined = manager.createRemoteWorkspaceSession(
      win as never,
      alternateProfileTarget,
      "connect-alternate-profile",
    );
    await emitConnected({
      child,
      requestId: "connect-alternate-profile",
      remoteSessionId: "remote-session-1",
      sourceServerId: "source-1",
      waitForAttachment: false,
      // Host 返回真正持有 logical session 的 canonical entry target，而不是请求线路。
      target: sshTarget,
    });

    await expect(joined).resolves.toBe("remote-session-1");
    expect(win.webContents.postMessage).not.toHaveBeenCalledWith(
      InternalChannels.ScopedServicePort,
      expect.anything(),
      expect.anything(),
    );
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      }),
    );
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(true);
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, alternateProfileTarget)).toBe(
      false,
    );
  });

  it("忽略过期 ready ACK，超时只回收且不提升候选 attachment", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockUtilityProcess(1001);
      const win = createWindow(1, 101);
      const manager = createManager(new Map([[101, child]]), {
        rendererAttachmentReadyTimeoutMs: 10,
      });
      const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
      await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
      const firstAttachment = getLatestScopedAttachment(win);
      confirmLatestScopedAttachment(manager, win);
      await connecting;
      child.postMessage.mockClear();

      const binding = manager.bindRemoteWorkspaceSessionContext(
        "remote-session-1",
        { workspacePath: "/work/demo" },
        101,
      );
      const bindRequest = child.postMessage.mock.calls[0]?.[0] as { requestId: string };
      child.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceContextBound,
        requestId: bindRequest.requestId,
      });
      await Promise.resolve();
      const candidateAttachment = getLatestScopedAttachment(win);
      manager.confirmRendererAttachmentReady(101, firstAttachment);
      const bindingRejection = expect(binding).rejects.toThrow("renderer attachment ready 超时");
      await vi.advanceTimersByTimeAsync(10);

      await bindingRejection;
      expect(child.postMessage).toHaveBeenCalledWith({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: candidateAttachment.attachmentId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("手机 runtime attachment 到已有窗口 Local Host", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath: "/work/demo",
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    const mobile = manager.attachRemoteWorkspaceSessionHost({
      windowId: 1,
      remoteSessionId: "remote-session-1",
      workspacePath: "/work/demo",
      workspaceIdentity,
      workspaceKey: workspaceIdentity,
      clientMode: "web-remote-replayable",
    });
    expect(mobile.process).toBe(child);
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    for (const [message] of child.postMessage.mock.calls) {
      expect(message).toMatchObject({
        type: HostMessageTypes.AttachServicePort,
        clientMode: "web-remote-replayable",
        scope: { kind: "remote", remoteSessionId: "remote-session-1" },
      });
    }
  });

  it("renderer reload 只重建 attachment，复用 session 与 Host PID", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1");
    await emitConnected({ child, requestId: "connect-1", remoteSessionId: "remote-session-1" });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "renderer-reload");

    expect(child.pid).toBe(1001);
    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      scope: { kind: "remote", remoteSessionId: "remote-session-1" },
    });
    expect(
      child.postMessage.mock.calls.some(
        ([message]) => message.type === HostMessageTypes.ConnectRemoteWorkspace,
      ),
    ).toBe(false);
    confirmLatestScopedAttachment(manager, win);
  });

  it("连接断开后保留离线路由供 tab dispose，但禁止 reload、手机和 Bot 重新 attachment", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const workspacePath = "/work/demo";
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath,
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath,
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();

    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "remote-session-1",
      reason: "connection-closed",
      exitCode: 255,
      signal: null,
      recoverable: true,
      recoveryAttempt: 2,
      recoveryLimit: 3,
    });
    manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "renderer-reload");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: expect.any(String),
    });
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: HostMessageTypes.AttachServicePort }),
      expect.anything(),
    );
    expect(() =>
      manager.attachRemoteWorkspaceSessionHost({
        windowId: 1,
        remoteSessionId: "remote-session-1",
        workspacePath,
        workspaceIdentity,
        workspaceKey: workspaceIdentity,
        clientMode: "web-remote-replayable",
      }),
    ).toThrow("远程 workspace source 当前离线");
    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      }),
    );
  });

  async function setupSourceReconnect(
    providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator,
  ) {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hosts = new Map([[101, child]]);
    const manager = createManager(hosts, { logger, providerProvisioningCoordinator });
    const workspacePath = "/work/demo";
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath,
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath,
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    const originalAttachment = getLatestScopedAttachment(win);
    child.postMessage.mockClear();
    win.webContents.send.mockClear();
    const reconnect = (
      previousRemoteSessionId: string,
      remoteSessionId: string,
      generation: number,
    ) => {
      child.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceReconnected,
        previousRemoteSessionId,
        descriptor: {
          remoteSessionId,
          target: sshTarget,
          workspacePath,
          workspaceIdentity,
          generation,
        },
      });
      return getLatestScopedAttachment(win);
    };
    const notices = () =>
      win.webContents.send.mock.calls
        .filter(([channel]) => channel === PlatformChannels.RemoteSessionReconnected)
        .map(([, payload]) => payload);
    return {
      child,
      win,
      logger,
      hosts,
      manager,
      workspacePath,
      workspaceIdentity,
      originalAttachment,
      reconnect,
      notices,
    };
  }

  it.each(["ACK前", "ACK后通知前"] as const)(
    "Source 重连%s关闭旧 Renderer session，释放当前 scope/配置登记且不能通知",
    async (phase) => {
      const coordinator = new ProviderProvisioningEnvironmentCoordinator();
      const { child, manager, logger, win, reconnect, notices } =
        await setupSourceReconnect(coordinator);
      const candidate = reconnect("remote-session-1", "remote-session-2", 2);
      if (phase === "ACK后通知前") manager.confirmRendererAttachmentReady(101, candidate);
      child.postMessage.mockClear();
      manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
      expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          remoteSessionId: "remote-session-2",
        }),
      );
      expect(child.postMessage).toHaveBeenCalledWith({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: candidate.attachmentId,
      });
      manager.disposeRemoteWorkspaceSession("remote-session-1", "duplicate-old");
      manager.disposeRemoteWorkspaceSession("remote-session-2", "duplicate-current");
      manager.confirmRendererAttachmentReady(101, candidate);
      await coordinator.requestAll("personal-config");
      expect(
        child.postMessage.mock.calls.filter(
          ([message]) => message.type === HostMessageTypes.ProviderProvisioningExecute,
        ),
      ).toEqual([]);
      expect(
        child.postMessage.mock.calls.filter(
          ([message]) => message.type === HostMessageTypes.DisposeRemoteWorkspaceSession,
        ),
      ).toHaveLength(1);
      expect(
        child.postMessage.mock.calls.filter(
          ([message]) =>
            message.type === HostMessageTypes.DetachServicePort &&
            message.attachmentId === candidate.attachmentId,
        ),
      ).toHaveLength(1);
      if (phase === "ACK前")
        await vi.waitFor(() =>
          expect(logger.warn).toHaveBeenCalledWith(
            "[window-host-remote] reconnect renderer attachment failed",
            expect.objectContaining({ sessionId: "remote-session-2" }),
          ),
        );
      else
        await vi.waitFor(() =>
          expect(logger.info).toHaveBeenCalledWith(
            "[window-host-remote] ignore superseded reconnect attachment",
            expect.objectContaining({ sessionId: "remote-session-2" }),
          ),
        );
      expect(notices()).toEqual([]);
    },
  );

  it("Source A→B→C时关闭最后已发布A，回收C而非已失效B", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();
    const { child, manager, logger, win, reconnect, notices } =
      await setupSourceReconnect(coordinator);
    const previous = reconnect("remote-session-1", "remote-session-2", 2);
    const candidate = reconnect("remote-session-2", "remote-session-3", 3);
    child.postMessage.mockClear();
    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
    expect(
      child.postMessage.mock.calls
        .filter(([message]) => message.type === HostMessageTypes.DisposeRemoteWorkspaceSession)
        .map(([message]) => message.remoteSessionId),
    ).toEqual(["remote-session-3"]);
    manager.confirmRendererAttachmentReady(101, previous);
    manager.confirmRendererAttachmentReady(101, candidate);
    await coordinator.requestAll("personal-config");
    expect(
      child.postMessage.mock.calls.filter(
        ([message]) => message.type === HostMessageTypes.ProviderProvisioningExecute,
      ),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        "[window-host-remote] reconnect renderer attachment failed",
        expect.objectContaining({ sessionId: "remote-session-3" }),
      ),
    );
    expect(notices()).toEqual([]);
  });

  it("Source旧关联重复释放不误删后续独立owner，即使target与workspace相同", async () => {
    const { child, manager, logger, win, workspacePath, workspaceIdentity, reconnect, notices } =
      await setupSourceReconnect();
    reconnect("remote-session-1", "remote-session-2", 2);
    manager.disposeRemoteWorkspaceSession("remote-session-1", "tab-closed");
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        "[window-host-remote] reconnect renderer attachment failed",
        expect.objectContaining({ sessionId: "remote-session-2" }),
      ),
    );
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      sshTarget,
      "independent",
      {
        workspacePath,
        workspaceIdentity,
      },
    );
    await emitConnected({
      child,
      requestId: "independent",
      remoteSessionId: "independent-session",
      workspacePath,
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    child.postMessage.mockClear();
    manager.disposeRemoteWorkspaceSession("remote-session-1", "late-old");
    manager.disposeRemoteWorkspaceSession("remote-session-2", "late-current");
    expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(true);
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    manager.disposeRemoteWorkspaceSession("independent-session");
    expect(
      child.postMessage.mock.calls
        .filter(([message]) => message.type === HostMessageTypes.DisposeRemoteWorkspaceSession)
        .map(([message]) => message.remoteSessionId),
    ).toEqual(["independent-session"]);
  });

  it("Source 重连先恢复 Desktop，未完成的 Provisioning 不阻塞 renderer ACK 提交", async () => {
    const { child, manager, reconnect, notices, originalAttachment } = await setupSourceReconnect();
    child.autoProvisioning = false;
    const candidate = reconnect("remote-session-1", "remote-session-2", 2);
    expect(candidate.sessionId).toBe("remote-session-2");
    expect(candidate.attachmentId).not.toBe(originalAttachment.attachmentId);
    expect(notices()).toEqual([]);
    expect(child.postMessage).not.toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: originalAttachment.attachmentId,
    });
    manager.confirmRendererAttachmentReady(101, originalAttachment);
    manager.confirmRendererAttachmentReady(202, candidate);
    expect(notices()).toEqual([]);
    manager.confirmRendererAttachmentReady(101, candidate);
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: originalAttachment.attachmentId,
    });
    await vi.waitFor(() =>
      expect(notices()).toEqual([
        {
          previousSessionId: "remote-session-1",
          sessionId: "remote-session-2",
          workspacePath: "/work/demo",
          workspaceIdentity: "remote:ssh:dev.internal:22:developer:/work/demo",
        },
      ]),
    );
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.ProviderProvisioningExecute,
        remoteSessionId: "remote-session-2",
      }),
    );
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it("Source 连续两次重连只提交最新 candidate，通知仍显示旧 session 的 Renderer", async () => {
    const { child, manager, reconnect, notices } = await setupSourceReconnect();
    const first = reconnect("remote-session-1", "remote-session-2", 2);
    expect(first.sessionId).toBe("remote-session-2");
    const latest = reconnect("remote-session-2", "remote-session-3", 3);
    expect(latest.sessionId).toBe("remote-session-3");
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: first.attachmentId,
    });
    manager.confirmRendererAttachmentReady(101, first);
    expect(notices()).toEqual([]);
    manager.confirmRendererAttachmentReady(101, latest);
    await vi.waitFor(() =>
      expect(notices()).toEqual([
        expect.objectContaining({
          previousSessionId: "remote-session-1",
          sessionId: "remote-session-3",
        }),
      ]),
    );
    expect(child.postMessage).not.toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: latest.attachmentId,
    });
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it("Source 的 B ACK 后 C 已开始时，B 的迟到 continuation 不发布旧通知", async () => {
    const { manager, reconnect, notices } = await setupSourceReconnect();
    const first = reconnect("remote-session-1", "remote-session-2", 2);
    expect(first.sessionId).toBe("remote-session-2");
    manager.confirmRendererAttachmentReady(101, first);
    const latest = reconnect("remote-session-2", "remote-session-3", 3);
    expect(latest.sessionId).toBe("remote-session-3");
    manager.confirmRendererAttachmentReady(101, latest);
    await vi.waitFor(() =>
      expect(notices()).toEqual([
        expect.objectContaining({
          previousSessionId: "remote-session-1",
          sessionId: "remote-session-3",
        }),
      ]),
    );
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it.each(["connection-closed", "window-closed", "host-exit"] as const)(
    "Source 重连 ACK 前 %s 使 candidate 失效，迟到 ACK 不发布通知",
    async (reason) => {
      const { child, win, manager, reconnect, notices, logger } = await setupSourceReconnect();
      const candidate = reconnect("remote-session-1", "remote-session-2", 2);
      expect(candidate.sessionId).toBe("remote-session-2");
      if (reason === "connection-closed")
        child.emit("message", {
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: "remote-session-2",
          reason: "connection-closed",
          recoverable: true,
        });
      else if (reason === "window-closed") manager.disposeRemoteWorkspaceSessionsForWindow(101);
      else child.emit("exit");
      manager.confirmRendererAttachmentReady(101, candidate);
      // 观察 reject 的恢复链已收口，而不是靠固定微任务数猜测通知不会到达。
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          "[window-host-remote] reconnect renderer attachment failed",
          expect.objectContaining({ sessionId: "remote-session-2" }),
        ),
      );
      expect(notices()).toEqual([]);
      manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "late-reload");
      expect(getLatestScopedAttachment(win)).toEqual(candidate);
      expect(manager.hasRemoteWorkspaceSessionForTarget(win as never, sshTarget)).toBe(false);
      manager.disposeRemoteWorkspaceSessionsForWindow(101);
    },
  );

  it.each(["connection-closed", "window-closed", "host-exit"] as const)(
    "Source ACK 后 %s 仍阻止尚未发出的重连通知",
    async (reason) => {
      const { child, win, manager, reconnect, notices, logger } = await setupSourceReconnect();
      const candidate = reconnect("remote-session-1", "remote-session-2", 2);
      expect(candidate.sessionId).toBe("remote-session-2");
      manager.confirmRendererAttachmentReady(101, candidate);
      if (reason === "connection-closed")
        child.emit("message", {
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: "remote-session-2",
          reason: "connection-closed",
          recoverable: true,
        });
      else if (reason === "window-closed") {
        win.isDestroyed = () => true;
        manager.disposeRemoteWorkspaceSessionsForWindow(101);
      } else child.emit("exit");
      await vi.waitFor(() =>
        expect(logger.info).toHaveBeenCalledWith(
          "[window-host-remote] ignore superseded reconnect attachment",
          expect.objectContaining({ sessionId: "remote-session-2" }),
        ),
      );
      expect(notices()).toEqual([]);
      manager.disposeRemoteWorkspaceSessionsForWindow(101);
    },
  );

  it("Source attachment 传递失败回收本 candidate、记录 warning，后续重连仍可提交", async () => {
    const { child, win, manager, logger, reconnect, notices } = await setupSourceReconnect();
    win.webContents.postMessage.mockImplementationOnce(() => {
      throw new Error("port delivery failed");
    });
    reconnect("remote-session-1", "remote-session-2", 2);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        "[window-host-remote] reconnect renderer attachment failed",
        expect.objectContaining({ sessionId: "remote-session-2" }),
      ),
    );
    const failed = child.postMessage.mock.calls.find(
      ([message]) =>
        message.type === HostMessageTypes.AttachServicePort &&
        message.scope.remoteSessionId === "remote-session-2",
    )![0];
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: failed.attachmentId,
    });
    expect(channels.at(-1)?.port1.close).toHaveBeenCalledOnce();
    expect(notices()).toEqual([]);
    const latest = reconnect("remote-session-2", "remote-session-3", 3);
    expect(latest.sessionId).toBe("remote-session-3");
    manager.confirmRendererAttachmentReady(101, latest);
    await vi.waitFor(() =>
      expect(notices()).toEqual([
        expect.objectContaining({
          previousSessionId: "remote-session-1",
          sessionId: "remote-session-3",
        }),
      ]),
    );
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  async function reconnectSourceSession(params: {
    child: MockUtilityProcess;
    win: ReturnType<typeof createWindow>;
    manager: ReturnType<typeof createManager>;
    workspacePath: string;
    workspaceIdentity: string;
  }) {
    params.child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "remote-session-1",
      reason: "connection-closed",
      exitCode: 255,
      signal: null,
      recoverable: true,
      recoveryAttempt: 1,
      recoveryLimit: 3,
    });
    params.child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceReconnected,
      previousRemoteSessionId: "remote-session-1",
      descriptor: {
        remoteSessionId: "remote-session-2",
        target: sshTarget,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        generation: 2,
      },
    });
    expect(getLatestScopedAttachment(params.win).sessionId).toBe("remote-session-2");
    confirmLatestScopedAttachment(params.manager, params.win);
    await vi.waitFor(() =>
      expect(params.win.webContents.send).toHaveBeenCalledWith(
        PlatformChannels.RemoteSessionReconnected,
        expect.objectContaining({ sessionId: "remote-session-2" }),
      ),
    );
  }

  it("Source 自动重连后以新 sessionId 重新登记 Provisioning lane 并重新下发", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const workspacePath = "/work/demo";
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath,
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath,
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.ProviderProvisioningExecute,
        remoteSessionId: "remote-session-1",
        trigger: "environment-online",
      }),
    );
    child.postMessage.mockClear();

    await reconnectSourceSession({ child, win, manager, workspacePath, workspaceIdentity });

    // 远端 daemon 重连视为 Environment 重新上线：离线期间的本机配置变更必须整份重新下发。
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.ProviderProvisioningExecute,
        remoteSessionId: "remote-session-2",
        trigger: "environment-online",
      }),
    );
    child.postMessage.mockClear();

    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningSourceChanged,
      trigger: "personal-config",
    });
    await vi.waitFor(() =>
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: HostMessageTypes.ProviderProvisioningExecute,
          trigger: "personal-config",
        }),
      ),
    );

    const provisioningExecutions = child.postMessage.mock.calls
      .map(([message]) => message as { type?: string; remoteSessionId?: string; trigger?: string })
      .filter((message) => message.type === HostMessageTypes.ProviderProvisioningExecute);
    expect(provisioningExecutions).toEqual([
      expect.objectContaining({ remoteSessionId: "remote-session-2", trigger: "personal-config" }),
    ]);
  });

  it("重连触发的 Provisioning 失败只记录 warning，不拆除已重连的 Workspace", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = createManager(new Map([[101, child]]), { logger });
    const workspacePath = "/work/demo";
    const workspaceIdentity = "remote:ssh:dev.internal:22:developer:/work/demo";
    const connecting = manager.createRemoteWorkspaceSession(win as never, sshTarget, "connect-1", {
      workspacePath,
      workspaceIdentity,
    });
    await emitConnected({
      child,
      requestId: "connect-1",
      remoteSessionId: "remote-session-1",
      workspacePath,
      workspaceIdentity,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    child.provisioningResult = { status: "failed", error: "token=secret-value" };
    await reconnectSourceSession({ child, win, manager, workspacePath, workspaceIdentity });

    expect(getLatestScopedAttachment(win).sessionId).toBe("remote-session-2");
    expect(logger.warn).toHaveBeenCalledWith(
      "[provider-provisioning] Environment resync after reconnect did not apply",
      expect.objectContaining({ remoteSessionId: "remote-session-2" }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-value");
    expect(child.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-2",
      }),
    );
  });
  it("手机项目准备只转交 Host descriptor，不创建桌面 tab/continuous attachment", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const pending = manager.prepareProjectWorkspace(
      win as never,
      { projectId: "p", hostId: "remote:server:s" },
      "mobile-project",
    );
    expect(child.postMessage).toHaveBeenCalledWith({
      type: HostMessageTypes.PrepareProjectWorkspace,
      requestId: "mobile-project",
      projectId: "p",
      hostId: "remote:server:s",
      clientMode: "web-remote-replayable",
    });
    const remote = {
      sourceServerId: "s",
      remoteSessionId: "mobile-scope",
      workspacePath: "/new",
      workspaceIdentity: "remote:server:s:/new",
      generation: 1,
      target: sshTarget,
    };
    child.emit("message", {
      type: HostResponseTypes.ProjectWorkspacePrepared,
      requestId: "mobile-project",
      result: {
        ok: true,
        value: {
          projectId: "p",
          hostId: "remote:server:s",
          workspacePath: "/new",
          workspaceIdentity: remote.workspaceIdentity,
          additionalDirectories: [],
          remote,
        },
      },
    });
    expect((await pending).remote?.remoteSessionId).toBe("mobile-scope");
    manager.reattachRemoteWorkspaceSessionsForWindow(win as never, "renderer-reload");
    expect(win.webContents.postMessage).not.toHaveBeenCalled();
    const mobile = manager.attachRemoteWorkspaceSessionHost({
      windowId: 1,
      remoteSessionId: "mobile-scope",
      workspacePath: "/new",
      workspaceIdentity: remote.workspaceIdentity,
      workspaceKey: remote.workspaceIdentity,
      clientMode: "web-remote-replayable",
    });
    expect(mobile.process).toBe(child);
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceReconnected,
      previousRemoteSessionId: "mobile-scope",
      descriptor: { ...remote, remoteSessionId: "mobile-reconnected", generation: 2 },
    });
    expect(
      manager.attachRemoteWorkspaceSessionHost({
        windowId: 1,
        remoteSessionId: "mobile-reconnected",
        workspacePath: "/new",
        workspaceIdentity: remote.workspaceIdentity,
        workspaceKey: remote.workspaceIdentity,
        clientMode: "web-remote-replayable",
      }).process,
    ).toBe(child);
    expect(() =>
      manager.attachRemoteWorkspaceSessionHost({
        windowId: 1,
        remoteSessionId: "mobile-scope",
        workspacePath: "/new",
        workspaceIdentity: remote.workspaceIdentity,
        workspaceKey: remote.workspaceIdentity,
        clientMode: "web-remote-replayable",
      }),
    ).toThrow("未找到远程 workspace session");
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.RemoteSessionReconnected,
      expect.anything(),
    );
    expect(win.webContents.postMessage).not.toHaveBeenCalled();
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it("Host 退出使尚未完成的项目导航失败，不留下永不返回的请求", async () => {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const pending = manager.prepareProjectWorkspace(
      win as never,
      { projectId: null },
      "mobile-project",
    );
    const rejected = expect(pending).rejects.toThrow("Host");
    child.emit("exit", 1);
    await rejected;
  });
  it("Host 返回目录后、首次配置同步完成前退出也必须结束导航请求", async () => {
    const child = new MockUtilityProcess(1001);
    child.postMessage.mockImplementation(() => undefined);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const rejected = vi.fn();
    void manager
      .prepareProjectWorkspace(
        win as never,
        { projectId: "p", hostId: "remote:server:s" },
        "mobile-project",
      )
      .catch(rejected);
    child.emit("message", {
      type: HostResponseTypes.ProjectWorkspacePrepared,
      requestId: "mobile-project",
      result: {
        ok: true,
        value: {
          projectId: "p",
          hostId: "remote:server:s",
          workspacePath: "/new",
          workspaceIdentity: "remote:server:s:/new",
          additionalDirectories: [],
          remote: {
            sourceServerId: "s",
            remoteSessionId: "mobile-scope",
            workspacePath: "/new",
            workspaceIdentity: "remote:server:s:/new",
            generation: 1,
            target: sshTarget,
          },
        },
      },
    });
    child.emit("exit", 1);
    await vi.waitFor(() =>
      expect(rejected).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Host") }),
      ),
    );
  });

  it("窗口关闭后不能把迟到的配置成功结果返回为导航成功", async () => {
    const child = new MockUtilityProcess(1001);
    child.postMessage.mockImplementation(() => undefined);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const settled = vi.fn();
    void manager
      .prepareProjectWorkspace(
        win as never,
        { projectId: "p", hostId: "remote:server:s" },
        "mobile-project",
      )
      .then(
        () => settled("success"),
        () => settled("rejected"),
      );
    child.emit("message", {
      type: HostResponseTypes.ProjectWorkspacePrepared,
      requestId: "mobile-project",
      result: {
        ok: true,
        value: {
          projectId: "p",
          hostId: "remote:server:s",
          workspacePath: "/new",
          workspaceIdentity: "remote:server:s:/new",
          additionalDirectories: [],
          remote: {
            sourceServerId: "s",
            remoteSessionId: "mobile-scope",
            workspacePath: "/new",
            workspaceIdentity: "remote:server:s:/new",
            generation: 1,
            target: sshTarget,
          },
        },
      },
    });
    await vi.waitFor(() =>
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: HostMessageTypes.ProviderProvisioningExecute }),
      ),
    );
    const command = child.postMessage.mock.calls.find(
      ([message]) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )![0];
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: command.requestId,
      environmentKey: command.environmentKey,
      status: "applied",
    });
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    expect(settled).toHaveBeenCalledWith("rejected");
  });
});

describe("mobile scope admission joins", () => {
  function setup() {
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const manager = createManager(new Map([[101, child]]));
    const value = {
      projectId: "p",
      hostId: "remote:server:s",
      workspacePath: "/new",
      workspaceIdentity: "remote:server:s:/new",
      additionalDirectories: [],
      remote: {
        sourceServerId: "s",
        remoteSessionId: "mobile-scope",
        workspacePath: "/new",
        workspaceIdentity: "remote:server:s:/new",
        generation: 1,
        target: sshTarget,
      },
    };
    const prepare = (requestId: string) => {
      const result = manager.prepareProjectWorkspace(
        win as never,
        { projectId: "p", hostId: value.hostId },
        requestId,
      );
      child.emit("message", {
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId,
        result: { ok: true, value },
      });
      return result;
    };
    return { child, win, manager, prepare };
  }
  it("a second navigation waits for the shared scope's initial provisioning", async () => {
    const { child, manager, prepare } = setup();
    child.postMessage.mockImplementation(() => undefined);
    const first = prepare("first");
    await vi.waitFor(() =>
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: HostMessageTypes.ProviderProvisioningExecute }),
      ),
    );
    const settled = vi.fn();
    const second = prepare("second").then(settled);
    await Promise.resolve();
    await Promise.resolve();
    const completedBeforeProvisioning = settled.mock.calls.length;
    const command = child.postMessage.mock.calls.find(
      ([message]) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )![0];
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: command.requestId,
      environmentKey: command.environmentKey,
      status: "applied",
    });
    await Promise.all([first, second]);
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
    expect(completedBeforeProvisioning).toBe(0);
  });
  it("desktop adoption of a mobile scope completes only after renderer readiness", async () => {
    const { child, win, manager, prepare } = setup();
    await prepare("mobile");
    expect(win.webContents.postMessage).not.toHaveBeenCalled();
    const settled = vi.fn();
    const desktop = manager
      .createRemoteWorkspaceSession(win as never, sshTarget, "desktop")
      .then(settled);
    await emitConnected({ child, requestId: "desktop", remoteSessionId: "mobile-scope" });
    expect(settled).not.toHaveBeenCalled();
    expect(getLatestScopedAttachment(win).sessionId).toBe("mobile-scope");
    confirmLatestScopedAttachment(manager, win);
    await desktop;
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("mobile-scope");
    manager.disposeRemoteWorkspaceSessionsForWindow(101);
  });

  it("新建连接未带 context 时，手机桥接必须等 UI 绑定选中目录后才能通过 identity 校验", async () => {
    // 回归锁定（3.12.0 手机远控连不上 WSL 项目）：新建连接不带 context，Host descriptor 停留在 "/"，
    // identity 由解析后的 target 生成；UI tab 用未解析 target 生成的 identity 与之不同。
    // BindRemoteWorkspaceSessionContext 是唯一能让 descriptor 与 tab 对齐的入口，缺了它桥接必然被拒。
    const child = new MockUtilityProcess(1001);
    const win = createWindow(1, 101);
    const resolvedWslTarget = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;
    const manager = createManager(new Map([[101, child]]), {
      resolveWslTarget: async () => resolvedWslTarget,
    });
    const connecting = manager.createRemoteWorkspaceSession(
      win as never,
      { kind: "wsl" },
      "connect-wsl",
    );
    await vi.waitFor(() =>
      expect(child.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: HostMessageTypes.ConnectRemoteWorkspace }),
      ),
    );
    await emitConnected({
      child,
      requestId: "connect-wsl",
      remoteSessionId: "remote-session-1",
      target: resolvedWslTarget,
    });
    confirmLatestScopedAttachment(manager, win);
    await connecting;

    const tabIdentity = "remote:wsl:default:/home/dev";
    const attachMobile = () =>
      manager.attachRemoteWorkspaceSessionHost({
        windowId: 1,
        remoteSessionId: "remote-session-1",
        workspacePath: "/home/dev",
        workspaceIdentity: tabIdentity,
        workspaceKey: tabIdentity,
        clientMode: "web-remote-replayable",
      });
    expect(attachMobile).toThrow("远程 workspaceKey 与 logical session 不匹配。");

    child.postMessage.mockClear();
    const previousAttachmentId = getLatestScopedAttachment(win).attachmentId;
    const binding = manager.bindRemoteWorkspaceSessionContext(
      "remote-session-1",
      { workspacePath: "/home/dev", workspaceIdentity: tabIdentity },
      101,
    );
    // R3 的 main bind 先等 Host 回 RemoteWorkspaceContextBound ACK，再换代 renderer attachment。
    const bindRequest = child.postMessage.mock.calls.find(
      ([message]) => message.type === HostMessageTypes.BindRemoteWorkspaceContext,
    )?.[0] as { requestId: string };
    expect(bindRequest).toBeDefined();
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceContextBound,
      requestId: bindRequest.requestId,
    });
    // 合并后 bind 仍等待新的 scoped attachment；不能用旧 attachment 的 ACK 越过新门禁。
    await vi.waitFor(() =>
      expect(getLatestScopedAttachment(win).attachmentId).not.toBe(previousAttachmentId),
    );
    confirmLatestScopedAttachment(manager, win);
    await binding;
    child.postMessage.mockClear();

    expect(attachMobile().remoteKind).toBe("wsl");
    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/home/dev",
        workspaceIdentity: tabIdentity,
      },
    });
  });
});
