import { describe, expect, it, vi } from "vitest";
import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type ModelSelectionView,
} from "@zcode/provider";
import { zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

const START_PLAN_PROVIDER_ID = "account:zai-start-plan";
const BIGMODEL_CODING_PLAN_PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const protocolModelProperties = {
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
};
type RegistryFixture = {
  generatedAt: number;
  revision: string;
  providers: Array<{
    providerId: string;
    apiFormat?: "anthropic-messages" | "openai-responses" | "openai-chat-completions";
    baseURL?: string;
    models: Array<{ modelId: string }>;
  }>;
};
class MockProcessManagerBase {
  // Bug 原因：service 现在订阅 runtime unavailable 生命周期来清理旧 client；这些 provider
  // 用例只验证 registry/model 语义，mock 必须提供同形状的空订阅，避免在业务断言前失败。
  onRuntimeLifecycle() {
    return { dispose() {} };
  }

  onRuntimeRestarted() {
    return { dispose() {} };
  }

  // Bug 根因：service 在 provider/model 门禁通过后会标记 runtime ready；共享 mock
  // 缺少该生命周期方法会让所有进入模型执行路径的用例在业务断言前统一失败。
  markReady() {}
}

function createSessionSnapshot(params: {
  model: { providerId: string; modelId: string };
  thoughtLevel?: string;
}) {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: "sess_1",
      workspace: {
        workspacePath: "/workspace/app",
        workspaceKey: "/workspace/app",
      },
      sessionKind: "interactive",
      title: "Runtime model test",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
    settings: {
      model: {
        current: params.model,
        available: [
          {
            ref: params.model,
            label: params.model.modelId,
            properties: protocolModelProperties,
          },
        ],
      },
      thoughtLevel: {
        enabled: params.thoughtLevel !== undefined,
        current: params.thoughtLevel,
        available: params.thoughtLevel
          ? [{ value: params.thoughtLevel, label: params.thoughtLevel }]
          : [],
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId: "sess_1",
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      pendingPermissions: [],
    },
    runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
    messages: [],
  };
}

function createStartPlanRegistry(params?: {
  glm52Levels?: string[];
  revision?: string;
}): RegistryFixture {
  const glm52Levels = params?.glm52Levels ?? ["max", "off"];
  return {
    generatedAt: 2,
    providers: [
      {
        providerId: START_PLAN_PROVIDER_ID,
        apiKeyRequired: false,
        kind: "openai-compatible",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan",
        models: [
          {
            modelId: "GLM-5.2",
            reasoning: {
              enabled: true,
              ...(glm52Levels[0] ? { defaultLevel: glm52Levels[0] } : {}),
              levels: glm52Levels.map((level) => ({ value: level, label: level })),
            },
          },
          {
            modelId: "GLM-5.1",
            reasoning: {
              enabled: true,
              defaultLevel: "enabled",
              levels: [
                { value: "enabled", label: "enabled" },
                { value: "off", label: "off" },
              ],
            },
          },
        ],
      },
    ],
    revision: params?.revision ?? "sha256:start-plan-registry-1",
  };
}

function createBigModelCodingPlanRegistry(params?: { revision?: string }): RegistryFixture {
  return {
    generatedAt: 2,
    providers: [
      {
        providerId: BIGMODEL_CODING_PLAN_PROVIDER_ID,
        apiKeyRequired: false,
        kind: "anthropic",
        baseURL: "https://open.bigmodel.cn/api/anthropic",
        models: [{ modelId: "GLM-5.2" }],
      },
    ],
    revision: params?.revision ?? "sha256:bigmodel-coding-plan-registry-1",
  };
}

function createModelSelectionChangeSource(initial: ModelSelectionView) {
  let view = initial;
  let listener: ((next: ModelSelectionView) => void) | undefined;
  return {
    source: {
      async getView() {
        return view;
      },
      onDidChange(callback: (next: ModelSelectionView) => void) {
        listener = callback;
        return {
          dispose() {
            if (listener === callback) listener = undefined;
          },
        };
      },
    },
    emit(next: ModelSelectionView) {
      view = next;
      listener?.(next);
    },
  };
}

function createModelSelectionViewFromRegistry(snapshot: RegistryFixture): ModelSelectionView {
  return {
    revision: snapshot.generatedAt,
    providers: snapshot.providers.map((provider) => ({
      providerId: provider.providerId,
      config: {
        kind: "api" as const,
        api: {
          type: provider.apiFormat ?? "openai-chat-completions",
          baseUrl: provider.baseURL,
        },
        models: provider.models.map((model) => model.modelId),
      },
      models: provider.models.map((model) => ({ modelId: model.modelId, config: {} })),
    })),
  };
}

function createReadyModelSelectionSource() {
  return createModelSelectionChangeSource(
    createModelSelectionViewFromRegistry(createStartPlanRegistry()),
  ).source;
}

describe("createZCodeAgentService provider registry", () => {
  it("uses the process model selection view for local startup without sending runtimeModel", async () => {
    const selectionSource = createModelSelectionChangeSource({
      revision: 1,
      providers: [
        {
          providerId: "custom-openai",
          config: {
            kind: "api",
            apiFormat: "openai-chat-completions",
            baseURL: "https://api.example.com/v1",
            models: ["agent-model"],
          },
          models: [{ modelId: "agent-model", config: {} }],
        },
      ],
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === zcodeProtocolMethods.sessionCreate) {
        const model = (params as { model: { providerId: string; modelId: string } }).model;
        return createSessionSnapshot({ model, thoughtLevel: "high" });
      }
      if (method === zcodeProtocolMethods.providerRefreshRegistry) return { refreshed: true };
      throw new Error(`Unexpected method ${method}`);
    });
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        async getClient() {
          return {
            request,
            transportKind: "stdio",
            onNotification: () => ({ dispose() {} }),
            onRequest: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
          };
        }
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: selectionSource.source,
    });

    await service.createSession({
      workspacePath: "/workspace/app",
      model: { providerId: "custom-openai", modelId: "agent-model" },
      thoughtLevel: "high",
    });

    const createCall = request.mock.calls.find(
      ([method]) => method === zcodeProtocolMethods.sessionCreate,
    );
    expect(createCall?.[1]).toMatchObject({
      model: { providerId: "custom-openai", modelId: "agent-model" },
      thoughtLevel: "high",
    });
    expect(
      (createCall?.[1] as { runtimeModel?: unknown } | undefined)?.runtimeModel,
    ).toBeUndefined();
    service.disposeAll();
  });

  it("starts a waiting local worker after the process model selection view becomes ready", async () => {
    const selectionSource = createModelSelectionChangeSource({
      revision: 1,
      providers: [],
    });
    const getClient = vi.fn(async () => ({
      request: vi.fn(async () => {
        throw new Error("Unexpected request");
      }),
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: selectionSource.source,
    });

    await expect(service.initialize({ workspacePath: "/workspace/app" })).resolves.toMatchObject({
      available: false,
    });
    expect(getClient).not.toHaveBeenCalled();

    selectionSource.emit({
      revision: 2,
      providers: [
        {
          providerId: "custom-openai",
          config: {
            kind: "api",
            apiFormat: "openai-chat-completions",
            baseURL: "https://api.example.com/v1",
            models: ["agent-model"],
          },
          models: [{ modelId: "agent-model", config: {} }],
        },
      ],
    });

    await vi.waitFor(() => expect(getClient).toHaveBeenCalledTimes(1));
    await expect(service.initialize({ workspacePath: "/workspace/app" })).resolves.toMatchObject({
      available: true,
    });
    service.disposeAll();
  });

  it("keeps initialize waiting without creating a client when provider/model is unavailable", async () => {
    const getClient = vi.fn();
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: createModelSelectionChangeSource({
        revision: 1,
        providers: [],
      }).source,
    });

    await expect(
      Promise.all([
        service.initialize({ workspacePath: "/workspace/app" }),
        service.initialize({ workspacePath: "/workspace/app" }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ available: false, reasonCode: "provider_not_ready" }),
      expect.objectContaining({ available: false, reasonCode: "provider_not_ready" }),
    ]);
    expect(getClient).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("keeps concurrent callers on the same ready startup generation available", async () => {
    const getClient = vi.fn(async () => ({
      request: vi.fn(),
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: createModelSelectionChangeSource(
        createModelSelectionViewFromRegistry(
          createStartPlanRegistry({ revision: "sha256:ready-concurrent" }),
        ),
      ).source,
    });
    const workspace = { workspacePath: "/workspace/concurrent-ready" };

    await expect(
      Promise.all([service.initialize(workspace), service.initialize(workspace)]),
    ).resolves.toEqual([
      expect.objectContaining({ available: true }),
      expect.objectContaining({ available: true }),
    ]);
    service.disposeAll();
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "并发预热完成不能让迟到的首条命令误判 runtime 已释放：%s",
    async (clientMode) => {
      const ready = createModelSelectionViewFromRegistry(createStartPlanRegistry());
      let finishLateRead!: (view: ModelSelectionView) => void;
      const lateRead = new Promise<ModelSelectionView>((resolve) => {
        finishLateRead = resolve;
      });
      const getView = vi.fn().mockResolvedValueOnce(ready).mockReturnValue(lateRead);
      const request = vi.fn(async () => ({
        commandId: "first-input",
        status: "accepted" as const,
        revisionAtDecision: 1,
      }));
      const getClient = vi.fn(async () => ({
        request,
        transportKind: "stdio" as const,
        onNotification: () => ({ dispose() {} }),
        onRequest: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
      }));
      vi.resetModules();
      vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
        ZCodeAgentProcessManager: class extends MockProcessManagerBase {
          getClient = getClient;
          disposeAll() {}
        },
      }));
      const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
      const service = createZCodeAgentService({ modelSelectionReadinessSource: { getView } });
      const workspace = {
        workspacePath: "/workspace/concurrent-first-input",
        ...(clientMode === "web-remote-replayable"
          ? { workspaceIdentity: "remote:ssh:first:/workspace/concurrent-first-input" }
          : {}),
      };
      try {
        const warmup = service.initialize(workspace);
        const command = service.sendConversationCommandV4({
          ...workspace,
          clientMode,
          envelope: {
            commandId: "first-input",
            clientId: clientMode,
            sessionId: "sess_1",
            type: "sendText",
            payload: { text: "first input" },
            issuedAt: 1,
          },
        });
        // 旧实现会分别读取 readiness；预热先完成并删掉等待记录，再让首条输入的读取返回。
        await expect(warmup).resolves.toMatchObject({ available: true });
        finishLateRead(ready);
        await expect(command).resolves.toMatchObject({ status: "accepted" });
        expect(getView).toHaveBeenCalledTimes(1);
        expect(getClient).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
          V4_METHODS.command,
          expect.objectContaining({ commandId: "first-input", type: "sendText" }),
          expect.anything(),
        );
      } finally {
        finishLateRead(ready);
        service.disposeAll();
      }
    },
  );

  it("释放并重新打开 workspace 后，旧 readiness 回调不能借用新 runtime", async () => {
    const ready = createModelSelectionViewFromRegistry(createStartPlanRegistry());
    let finishOldRead!: (view: ModelSelectionView) => void;
    const oldRead = new Promise<ModelSelectionView>((resolve) => {
      finishOldRead = resolve;
    });
    const getView = vi.fn().mockReturnValueOnce(oldRead).mockResolvedValue(ready);
    const getClient = vi.fn(async () => ({
      request: vi.fn(),
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        async disposeWorkspace() {}
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({ modelSelectionReadinessSource: { getView } });
    const workspace = { workspacePath: "/workspace/reopen-during-readiness" };
    try {
      const oldStartup = service.initialize(workspace);
      await service.disposeWorkspace(workspace);
      await expect(service.initialize(workspace)).resolves.toMatchObject({ available: true });
      finishOldRead(ready);
      await expect(oldStartup).resolves.toMatchObject({ available: false });
      expect(getClient).toHaveBeenCalledTimes(1);
    } finally {
      finishOldRead(ready);
      service.disposeAll();
    }
  });

  it("starts each waiting workspace identity once when provider/model becomes ready", async () => {
    const clients: Array<{
      request: ReturnType<typeof vi.fn>;
      transportKind: "stdio";
      onNotification: () => { dispose(): void };
      onRequest: () => { dispose(): void };
      onClose: () => { dispose(): void };
    }> = [];
    const getClient = vi.fn(async () => {
      const request = vi.fn(async (method: string) => {
        if (method === zcodeProtocolMethods.providerRefreshRegistry) return { refreshed: true };
        throw new Error(`Unexpected method ${method}`);
      });
      const client = {
        request,
        transportKind: "stdio" as const,
        onNotification: () => ({ dispose() {} }),
        onRequest: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
      };
      clients.push(client);
      return client;
    });
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeAll() {}
      },
    }));
    const selectionSource = createModelSelectionChangeSource({
      revision: 1,
      providers: [],
    });
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: selectionSource.source,
    });
    const firstIdentity = "remote:ssh:first:/workspace/app";
    const secondIdentity = "remote:ssh:second:/workspace/app";

    await service.initialize({
      workspacePath: "/workspace/app",
      workspaceIdentity: firstIdentity,
    });
    await service.initialize({
      workspacePath: "/workspace/app",
      workspaceIdentity: secondIdentity,
    });
    expect(getClient).not.toHaveBeenCalled();

    const ready = createStartPlanRegistry({ revision: "sha256:ready" });
    selectionSource.emit(createModelSelectionViewFromRegistry(ready));
    await vi.waitFor(() => expect(getClient).toHaveBeenCalledTimes(2));
    expect(getClient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity: firstIdentity }),
    );
    expect(getClient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity: secondIdentity }),
    );
    expect(
      clients.every((client) =>
        client.request.mock.calls.every(
          ([method]) => method === zcodeProtocolMethods.providerRefreshRegistry,
        ),
      ),
    ).toBe(true);

    selectionSource.emit(
      createModelSelectionViewFromRegistry({
        ...ready,
        generatedAt: ready.generatedAt + 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getClient).toHaveBeenCalledTimes(2);
    service.disposeAll();
  });

  it("readiness 读取中到达 ready 事件时，失败的旧启动不能吞掉新事件", async () => {
    const getClient = vi.fn(async () => ({
      request: vi.fn(),
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeAll() {}
      },
    }));
    const selectionSource = createModelSelectionChangeSource({ revision: 1, providers: [] });
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: selectionSource.source,
    });
    try {
      const initial = service.initialize({ workspacePath: "/workspace/ready-during-startup" });
      // getView 已取到空列表，但 await continuation 尚未恢复；此时仅发出一次 ready。
      selectionSource.emit(createModelSelectionViewFromRegistry(createStartPlanRegistry()));
      await expect(initial).resolves.toMatchObject({ available: false });
      await vi.waitFor(() => expect(getClient).toHaveBeenCalledTimes(1));
    } finally {
      service.disposeAll();
    }
  });

  it("does not restart a released workspace from an already queued provider-ready event", async () => {
    const getClient = vi.fn(async () => ({
      request: vi.fn(),
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    const disposeWorkspace = vi.fn(async () => {});
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeWorkspace = disposeWorkspace;
        disposeAll() {}
      },
    }));
    const selectionSource = createModelSelectionChangeSource({
      revision: 1,
      providers: [],
    });
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: selectionSource.source,
    });
    const workspace = { workspacePath: "/workspace/released-before-ready" };

    await expect(service.initialize(workspace)).resolves.toMatchObject({
      available: false,
      reasonCode: "provider_not_ready",
    });
    selectionSource.emit(
      createModelSelectionViewFromRegistry(
        createStartPlanRegistry({ revision: "sha256:ready-after-release" }),
      ),
    );
    await service.disposeWorkspace(workspace);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(disposeWorkspace).toHaveBeenCalledWith(workspace);
    expect(getClient).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("reuses a read-only sessions-index client when provider/model becomes ready", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "v4/conversation/subscribe") {
        return {
          ack: {
            subscriptionId: "sub-readonly",
            mode: "snapshot" as const,
            logEpoch: "epoch-readonly",
          },
        };
      }
      if (method === zcodeProtocolMethods.providerRefreshRegistry) return { refreshed: true };
      throw new Error(`Unexpected method ${method}`);
    });
    const getClient = vi.fn(async () => ({
      request,
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        getClient = getClient;
        disposeAll() {}
      },
    }));
    const selectionSource = createModelSelectionChangeSource({
      revision: 1,
      providers: [],
    });
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: selectionSource.source,
    });
    const workspacePath = "/workspace/read-only-then-ready";

    await service.subscribeSessionsIndexV4({ workspacePath });
    await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
      available: false,
      reasonCode: "provider_not_ready",
    });
    expect(getClient).toHaveBeenCalledTimes(1);

    selectionSource.emit(
      createModelSelectionViewFromRegistry(
        createStartPlanRegistry({ revision: "sha256:ready-after-readonly" }),
      ),
    );
    await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
      available: true,
    });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith(
      "workspace/updateProviderRegistry",
      expect.anything(),
      expect.anything(),
    );
    service.disposeAll();
  });

  it("does not push the full local registry before a V4 draft createSession command", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      calls.push(method);
      if (method === V4_METHODS.command) {
        const envelope = params as { commandId: string };
        return {
          commandId: envelope.commandId,
          status: "accepted" as const,
          revisionAtDecision: 1,
          result: { type: "createSession" as const, sessionId: "sess_v4_draft" },
        };
      }
      if (method === zcodeProtocolMethods.providerRefreshRegistry) return { refreshed: true };
      throw new Error(`Unexpected method ${method}`);
    });
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        async getClient() {
          return {
            request,
            transportKind: "stdio",
            onNotification: () => ({ dispose() {} }),
            onRequest: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
          };
        }
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: createReadyModelSelectionSource(),
    });

    const createPromise = service.sendConversationCommandV4({
      workspacePath: "/workspace/app",
      envelope: {
        commandId: "cmd-v4-draft-custom-model",
        clientId: "client-v4-draft",
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: "/workspace/app",
          config: {
            provider: "custom:glm",
            model: "glm-5.2",
            thought: "max",
          },
        },
        issuedAt: 1,
      },
    });

    await expect(createPromise).resolves.toMatchObject({
      status: "accepted",
      result: { type: "createSession", sessionId: "sess_v4_draft" },
    });
    expect(calls).toEqual([zcodeProtocolMethods.providerRefreshRegistry, V4_METHODS.command]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      V4_METHODS.command,
      expect.objectContaining({
        type: "createSession",
        payload: expect.objectContaining({
          config: expect.objectContaining({
            provider: "custom:glm",
            model: "glm-5.2",
          }),
        }),
      }),
      expect.any(Object),
    );
    service.disposeAll();
  });

  it.each(["refreshed", "failed"] as const)(
    "waits for the worker registry before switching a model with local configuration: %s",
    async (refreshResult) => {
      let finishRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      let waitingForRefresh = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === zcodeProtocolMethods.providerRefreshRegistry) {
          if (waitingForRefresh) {
            await refreshGate;
            if (refreshResult === "failed") throw new Error("registry refresh failed");
          }
          return { refreshed: true };
        }
        if (method === V4_METHODS.command) {
          return {
            commandId: (params as { commandId: string }).commandId,
            status: "accepted" as const,
            revisionAtDecision: 1,
          };
        }
        if (method === zcodeProtocolMethods.providerRefreshRegistry) return { refreshed: true };
        throw new Error(`Unexpected method ${method}`);
      });
      const client = {
        request,
        transportKind: "stdio",
        onNotification: () => ({ dispose() {} }),
        onRequest: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
      };
      vi.resetModules();
      vi.doMock("#src/zcode-agent/zcodeAgentProcessManager.js", () => ({
        ZCodeAgentProcessManager: class extends MockProcessManagerBase {
          async getClient() {
            return client;
          }
          disposeAll() {}
        },
      }));
      const { createZCodeAgentService } = await import("#src/zcode-agent/zcodeAgentService.js");
      const service = createZCodeAgentService({
        modelSelectionReadinessSource: createReadyModelSelectionSource(),
      });
      const workspace = { workspacePath: "/workspace/app" };
      try {
        await service.sendConversationCommandV4({
          ...workspace,
          envelope: {
            commandId: "warmup",
            clientId: "host-client",
            sessionId: "sess_1",
            type: "compact",
            payload: {},
            issuedAt: 1,
          },
        });
        request.mockClear();
        waitingForRefresh = true;
        const switching = service.sendConversationCommandV4({
          ...workspace,
          envelope: {
            commandId: "switch-model",
            clientId: "host-client",
            sessionId: "sess_1",
            type: "switchModelConfig",
            payload: { provider: "provisioned-provider", model: "model-a", thought: "" },
            issuedAt: 2,
          },
        });
        const outcome = switching.then(
          (ack) => ({ ack }),
          (error: unknown) => ({ error }),
        );
        await vi.waitFor(() => expect(request).toHaveBeenCalled());
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          zcodeProtocolMethods.providerRefreshRegistry,
        ]);
        finishRefresh();
        await expect(outcome).resolves.toMatchObject(
          refreshResult === "failed"
            ? { error: new Error("registry refresh failed") }
            : { ack: { status: "accepted" } },
        );
        expect(
          request.mock.calls.map(([method, params]) =>
            method === V4_METHODS.command
              ? `${method}:${(params as { type: string }).type}`
              : method,
          ),
        ).toEqual(
          refreshResult === "failed"
            ? [zcodeProtocolMethods.providerRefreshRegistry]
            : [
                zcodeProtocolMethods.providerRefreshRegistry,
                `${V4_METHODS.command}:switchModelConfig`,
              ],
        );
      } finally {
        finishRefresh();
        service.disposeAll();
      }
    },
  );

  it("workspace presentation does not attach Host-derived model facts", async () => {
    const request = vi.fn(async () => ({
      workspace: {
        workspacePath: "/workspace/app",
        workspaceKey: "/workspace/app",
      },
      mode: "build",
      slashCommands: [],
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class extends MockProcessManagerBase {
        async getClient() {
          return {
            request,
            transportKind: "stdio",
            onNotification: () => ({ dispose() {} }),
            onRequest: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
          };
        }
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: createReadyModelSelectionSource(),
    });

    await service.readWorkspacePresentation({ workspacePath: "/workspace/app" });

    const readPresentationCall = request.mock.calls.find(
      ([method]) => method === zcodeProtocolMethods.workspaceReadPresentation,
    );
    expect(readPresentationCall?.[1]).toMatchObject({
      workspace: {
        workspacePath: "/workspace/app",
        workspaceKey: "/workspace/app",
      },
    });
    expect(readPresentationCall?.[1]).not.toHaveProperty("model");
  });

  it("workspace presentation 在 stdio 关闭竞态下重新获取 client 并重试一次", async () => {
    const workspacePresentation = {
      workspace: {
        workspacePath: "/workspace/app",
        workspaceKey: "/workspace/app",
      },
      mode: "build",
      slashCommands: [],
    };
    const firstRequest = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workspaceReadPresentation) {
        throw new Error("ZCode agent stdio transport is closed");
      }
      return {
        workspace: workspacePresentation.workspace,
        status: "applied",
        providerCount: 1,
      };
    });
    const secondRequest = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workspaceReadPresentation) {
        return workspacePresentation;
      }
      return {
        workspace: workspacePresentation.workspace,
        status: "applied",
        providerCount: 1,
      };
    });
    const getClient = vi
      .fn()
      .mockResolvedValueOnce({
        request: firstRequest,
        transportKind: "stdio",
        onNotification: () => ({ dispose() {} }),
        onRequest: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
      })
      .mockResolvedValue({
        request: secondRequest,
        transportKind: "stdio",
        onNotification: () => ({ dispose() {} }),
        onRequest: () => ({ dispose() {} }),
        onClose: () => ({ dispose() {} }),
      });
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        getClient = getClient;
        // Bug 原因同共享 mock：service 构造期新增 runtime 生命周期订阅；本用例只驱动
        // stdio 重试，因此用空 disposable 补齐局部测试桩契约。
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        // Bugfix: rebase 后 service 会在构造期订阅 runtime restart；局部 process manager 测试桩
        // 必须保留该接口，否则尚未进入 stdio 重试断言就会因 mock 合约不完整失败。
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      modelSelectionReadinessSource: createReadyModelSelectionSource(),
    });

    await expect(
      service.readWorkspacePresentation({ workspacePath: "/workspace/app" }),
    ).resolves.toMatchObject(workspacePresentation);

    expect(getClient).toHaveBeenCalledTimes(2);
    expect(firstRequest).toHaveBeenCalledWith(
      zcodeProtocolMethods.workspaceReadPresentation,
      expect.anything(),
      expect.anything(),
    );
    expect(secondRequest).toHaveBeenCalledWith(
      zcodeProtocolMethods.workspaceReadPresentation,
      expect.anything(),
      expect.anything(),
    );
  });
});
