import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/provider";
import { zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import type { BrowserAmbientContextExecutor } from "../src/zcode-agent/zcodeAgentBrowserAmbientContext.js";

// docs/desktop/engine-performance-1.1-spec.md「Host 发送路径」HSP01-HSP04。

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.doUnmock("#src/zcode-agent/zcodeAgentProcessManager.js");
});

const READY_VIEW: ModelSelectionView = {
  revision: 1,
  providers: [
    {
      providerId: "provider-a",
      config: { kind: "api" },
      models: [{ modelId: "model-a", config: {} }],
    },
  ],
};

type FakeClient = {
  request: ReturnType<typeof vi.fn>;
  transportKind: "stdio";
  isDisposed?: boolean;
  onNotification: () => { dispose(): void };
  onRequest: () => { dispose(): void };
  onClose: () => { dispose(): void };
};

function createFakeClient(sessions: Array<{ sessionId: string; engine?: string }>): FakeClient {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === zcodeProtocolMethods.sessionList) {
      const ids = (params as { sessionIds?: string[] }).sessionIds ?? [];
      return { sessions: sessions.filter((session) => ids.includes(session.sessionId)) };
    }
    if (method === zcodeProtocolMethods.providerRefreshRegistry) return { refreshed: true };
    if (method === V4_METHODS.command) {
      const envelope = params as { commandId: string; type: string; sessionId: string | null };
      return {
        commandId: envelope.commandId,
        status: "accepted" as const,
        revisionAtDecision: 1,
        ...(envelope.type === "createSession"
          ? { result: { type: "createSession" as const, sessionId: "created-session" } }
          : {}),
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  return {
    request,
    transportKind: "stdio",
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  };
}

async function setup(options: {
  clients: FakeClient[];
  readProviderConfigRevision?: () => string | undefined;
  browserControlExecutor?: BrowserAmbientContextExecutor;
}) {
  const queue = [...options.clients];
  let current = queue.shift()!;
  const getClient = vi.fn(async () => {
    if (current.isDisposed && queue.length > 0) current = queue.shift()!;
    return current;
  });
  vi.resetModules();
  vi.doMock("#src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      // 1.1 闲置回收：service 取得 client 时续期计时（host-idle-resources-1.1-spec §2）。
      noteActivity() {}
      getClient = getClient;
      getExistingClient() {
        return current;
      }
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      markReady() {}
      disposeAll() {}
      async disposeAllAndWait() {}
      async disposeWorkspace() {}
    },
  }));
  const { createZCodeAgentService } = await import("#src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    externalEnginesSupported: true,
    externalEngineService: {
      getStatus: vi.fn(),
      listStatuses: async () => [],
      installAdapter: vi.fn(),
      onStatusChanged: () => ({ dispose() {} }),
      isLaunchReady: async () => true,
    } as never,
    modelSelectionReadinessSource: {
      getView: async () => READY_VIEW,
      onDidChange: () => ({ dispose() {} }),
    },
    ...(options.readProviderConfigRevision
      ? { readProviderConfigRevision: options.readProviderConfigRevision }
      : {}),
    ...(options.browserControlExecutor
      ? { browserControlExecutor: options.browserControlExecutor }
      : {}),
  });
  disposers.push(() => service.disposeAll());
  return { service, getClient };
}

function sendText(commandId: string, sessionId = "session-1") {
  return {
    workspacePath: "/workspace/app",
    envelope: {
      clientId: "client",
      commandId,
      type: "sendText" as const,
      sessionId,
      payload: { text: "hello" },
    },
  };
}

function methodsOf(client: FakeClient): string[] {
  return client.request.mock.calls.map(([method]) => method as string);
}

describe("Host 发送路径", () => {
  it("HSP01：同一会话第二次发送命中引擎缓存，不再调用 session/list", async () => {
    const client = createFakeClient([{ sessionId: "session-1", engine: "codex" }]);
    const { service } = await setup({ clients: [client] });

    await service.sendConversationCommandV4(sendText("first"));
    await service.sendConversationCommandV4(sendText("second"));

    expect(
      methodsOf(client).filter((method) => method === zcodeProtocolMethods.sessionList),
    ).toEqual([zcodeProtocolMethods.sessionList]);
    expect(methodsOf(client).filter((method) => method === V4_METHODS.command)).toHaveLength(2);
  });

  it("HSP01：查不到的会话不缓存为 zcode，下一次仍查询", async () => {
    const client = createFakeClient([]);
    const { service } = await setup({ clients: [client] });

    await service.sendConversationCommandV4(sendText("first", "missing"));
    await service.sendConversationCommandV4(sendText("second", "missing"));

    expect(
      methodsOf(client).filter((method) => method === zcodeProtocolMethods.sessionList),
    ).toHaveLength(2);
  });

  it("HSP02：createSession accepted 后按命令引擎缓存，deleteSession accepted 后失效", async () => {
    const client = createFakeClient([{ sessionId: "created-session", engine: "codex" }]);
    const { service } = await setup({ clients: [client] });

    await service.sendConversationCommandV4({
      workspacePath: "/workspace/app",
      envelope: {
        clientId: "client",
        commandId: "create",
        type: "createSession",
        sessionId: null,
        payload: { workspaceId: "/workspace/app", config: { engine: "codex" } },
      },
    });
    await service.sendConversationCommandV4(sendText("after-create", "created-session"));
    expect(methodsOf(client)).not.toContain(zcodeProtocolMethods.sessionList);

    await service.sendConversationCommandV4({
      workspacePath: "/workspace/app",
      envelope: {
        clientId: "client",
        commandId: "delete",
        type: "deleteSession",
        sessionId: "created-session",
        payload: {},
      },
    });
    const listCallsBefore = methodsOf(client).filter(
      (method) => method === zcodeProtocolMethods.sessionList,
    ).length;
    await service.sendConversationCommandV4(sendText("after-delete", "created-session"));
    expect(
      methodsOf(client).filter((method) => method === zcodeProtocolMethods.sessionList).length,
    ).toBe(listCallsBefore + 1);
  });

  it("HSP03：修订号不变时只刷新一次，修订号变化或 CLI 换代后重新刷新", async () => {
    const first = createFakeClient([{ sessionId: "session-1", engine: "zcode" }]);
    const second = createFakeClient([{ sessionId: "session-1", engine: "zcode" }]);
    let revision = "rev-1";
    const { service } = await setup({
      clients: [first, second],
      readProviderConfigRevision: () => revision,
    });
    const refreshCount = (client: FakeClient) =>
      methodsOf(client).filter((method) => method === zcodeProtocolMethods.providerRefreshRegistry)
        .length;

    await service.sendConversationCommandV4(sendText("a"));
    await service.sendConversationCommandV4(sendText("b"));
    expect(refreshCount(first)).toBe(1);

    revision = "rev-2";
    await service.sendConversationCommandV4(sendText("c"));
    expect(refreshCount(first)).toBe(2);

    // CLI 进程换代：旧 client disposed，新 client 首次使用必须刷新。
    first.isDisposed = true;
    await service.sendConversationCommandV4(sendText("d"));
    expect(refreshCount(second)).toBe(1);
  });

  it("HSP03：刷新失败不记录修订号，下一次发送重新刷新", async () => {
    const client = createFakeClient([{ sessionId: "session-1", engine: "zcode" }]);
    const original = client.request.getMockImplementation()!;
    let failNextRefresh = true;
    client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === zcodeProtocolMethods.providerRefreshRegistry && failNextRefresh) {
        failNextRefresh = false;
        throw new Error("registry refresh failed");
      }
      return original(method, params);
    });
    const { service } = await setup({ clients: [client], readProviderConfigRevision: () => "rev" });

    await expect(service.sendConversationCommandV4(sendText("a"))).rejects.toThrow(
      "registry refresh failed",
    );
    await service.sendConversationCommandV4(sendText("b"));
    await service.sendConversationCommandV4(sendText("c"));
    expect(
      methodsOf(client).filter((method) => method === zcodeProtocolMethods.providerRefreshRegistry),
    ).toHaveLength(2);
  });

  it("HSP03：未注入修订号时保持每次刷新", async () => {
    const client = createFakeClient([{ sessionId: "session-1", engine: "zcode" }]);
    const { service } = await setup({ clients: [client] });

    await service.sendConversationCommandV4(sendText("a"));
    await service.sendConversationCommandV4(sendText("b"));
    expect(
      methodsOf(client).filter((method) => method === zcodeProtocolMethods.providerRefreshRegistry),
    ).toHaveLength(2);
  });

  it("HSP04：Main 不回应环境上下文时，在预算内下发命令且不附带环境上下文", async () => {
    const client = createFakeClient([{ sessionId: "session-1", engine: "codex" }]);
    const execute = vi.fn(() => new Promise<never>(() => {}));
    const { service } = await setup({
      clients: [client],
      browserControlExecutor: {
        list: vi.fn(async () => [
          {
            id: "iab-runtime",
            generation: 1,
            type: "iab" as const,
            name: "ZCode In-app Browser",
            capabilities: {},
          },
        ]),
        execute,
      } as unknown as BrowserAmbientContextExecutor,
    });

    const startedAt = Date.now();
    await expect(service.sendConversationCommandV4(sendText("a"))).resolves.toMatchObject({
      status: "accepted",
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(execute).toHaveBeenCalled();
    const command = client.request.mock.calls.find(([method]) => method === V4_METHODS.command);
    expect(command).toBeDefined();
    const envelope = command![1] as { payload: Record<string, unknown> };
    expect(envelope.payload).not.toHaveProperty("browserAmbientContext");
  });
});
