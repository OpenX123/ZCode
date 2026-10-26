import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRemoteWorkspaceIdentity, zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import type { ExternalEngineStatus } from "@zcode/shared/external-engine";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.doUnmock("../src/zcode-agent/zcodeAgentProcessManager.js");
});

async function setup(ready: boolean, supported = true) {
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === zcodeProtocolMethods.sessionList)
      return { sessions: [{ sessionId: "external-session", engine: "codex" }] };
    if (method === V4_METHODS.command)
      return { status: "accepted", commandId: (params as { commandId: string }).commandId };
    if ([zcodeProtocolMethods.sessionCreate, zcodeProtocolMethods.sessionResume].includes(method))
      return { session: { sessionId: "external-session" }, messages: [], settings: { model: {} } };
    throw new Error(`Unexpected method ${method}`);
  });
  const client = {
    request,
    transportKind: "stdio",
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  };
  const getClient = vi.fn(async () => client);
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      getClient = getClient;
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      disposeAll() {}
      async disposeAllAndWait() {}
      async disposeWorkspace() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const status: ExternalEngineStatus = {
    engine: "codex",
    adapter: { installed: ready },
    officialCli: { found: true },
    auth: { state: "loggedIn" },
    ready,
  };
  const getStatus = vi.fn(async () => status);
  const prepareSessionCreation = vi.fn(async () => []);
  const service = createZCodeAgentService({
    externalEnginesSupported: supported,
    externalEngineService: {
      getStatus,
      listStatuses: async () => [status],
      installAdapter: vi.fn(),
      onStatusChanged: () => ({ dispose() {} }),
    },
    prepareSessionCreation,
    // 不提供模型 Registry：外部引擎应能独立工作，内置模型仍保持原就绪门禁。
  });
  disposers.push(() => service.disposeAll());
  return { service, request, getStatus, getClient, prepareSessionCreation };
}

function sendEnvelope() {
  return {
    clientId: "client",
    commandId: "command",
    type: "sendText" as const,
    sessionId: "external-session",
    payload: { text: "hello" },
  };
}

describe("Host 外部引擎执行门禁", () => {
  it.each(["workspace", "all", "allAndWait"] as const)(
    "%s 释放期间迟到的就绪结果不得重启 CLI 或预留项目 task",
    async (scope) => {
      const f = await setup(true);
      const readyStatus = await f.getStatus();
      let resolveStatus!: (status: ExternalEngineStatus) => void;
      f.getStatus.mockReturnValueOnce(
        new Promise<ExternalEngineStatus>((resolve) => {
          resolveStatus = resolve;
        }),
      );
      const creating = f.service.createSession({ workspacePath: "/workspace", engine: "codex" });
      const rejected = expect(creating).rejects.toMatchObject({
        code: "ZCODE_AGENT_RUNTIME_UNAVAILABLE",
      });
      if (scope === "workspace") await f.service.disposeWorkspace({ workspacePath: "/workspace" });
      else if (scope === "allAndWait") await f.service.disposeAllAndWait();
      else f.service.disposeAll();
      resolveStatus(readyStatus);
      await rejected;
      expect(f.getClient).not.toHaveBeenCalled();
      expect(f.prepareSessionCreation).not.toHaveBeenCalled();
    },
  );
  it("未就绪的创建不启动 CLI，不预留项目 task", async () => {
    const f = await setup(false);
    await expect(
      f.service.createSession({ workspacePath: "/workspace", engine: "codex" }),
    ).rejects.toMatchObject({
      code: "ZCODE_AGENT_ENGINE_NOT_READY",
      reasonCode: "engine_not_ready",
      engine: "codex",
    });
    expect(f.getClient).not.toHaveBeenCalled();
    expect(f.prepareSessionCreation).not.toHaveBeenCalled();
  });
  it("V4 首次发送在项目预留和命令提交前检查 engine", async () => {
    const f = await setup(false);
    await expect(
      f.service.sendConversationCommandV4({
        workspacePath: "/workspace",
        envelope: {
          clientId: "client",
          commandId: "create",
          type: "createSession",
          payload: {
            workspaceId: "workspace",
            config: { engine: "codex" },
            firstInput: { text: "hello" },
          },
        },
      }),
    ).rejects.toMatchObject({ reasonCode: "engine_not_ready" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.prepareSessionCreation).not.toHaveBeenCalled();
  });
  it("未就绪时仍允许 Stop 通过原命令通道", async () => {
    const f = await setup(false);
    await expect(
      f.service.sendConversationCommandV4({
        workspacePath: "/workspace",
        envelope: { ...sendEnvelope(), type: "stop", payload: {} },
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(f.getStatus).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      zcodeProtocolMethods.sessionList,
      V4_METHODS.command,
    ]);
  });
  it("无外部执行权限的 Host 拒绝已有外部会话", async () => {
    const f = await setup(true, false);
    await expect(
      f.service.sendConversationCommandV4({
        workspacePath: "/workspace",
        envelope: sendEnvelope(),
      }),
    ).rejects.toMatchObject({ reasonCode: "engine_not_ready" });
    expect(f.getStatus).not.toHaveBeenCalled();
    expect(f.request.mock.calls[0][1]).not.toHaveProperty("includeDrafts");
  });
  it("外部创建不依赖 Provider Registry，并向 CLI 传递 engine", async () => {
    const f = await setup(true);
    await f.service.createSession({ workspacePath: "/workspace", engine: "codex" });
    expect(f.request).toHaveBeenCalledWith(
      zcodeProtocolMethods.sessionCreate,
      expect.objectContaining({ engine: "codex" }),
      expect.anything(),
      undefined,
    );
    expect(
      f.request.mock.calls.some(
        ([method]) => method === zcodeProtocolMethods.providerRefreshRegistry,
      ),
    ).toBe(false);
  });
  it("冷发送从 CLI 持久化引擎判断，未就绪不下发 prompt", async () => {
    const f = await setup(false);
    await expect(
      f.service.sendConversationCommandV4({
        workspacePath: "/workspace",
        envelope: sendEnvelope(),
      }),
    ).rejects.toMatchObject({ reasonCode: "engine_not_ready" });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      zcodeProtocolMethods.sessionList,
    ]);
    expect(f.getStatus).toHaveBeenCalledWith("codex");
    expect(f.request).toHaveBeenCalledWith(
      zcodeProtocolMethods.sessionList,
      expect.objectContaining({ sessionIds: ["external-session"], includeDrafts: true }),
      expect.anything(),
    );
  });
  it("resume 同样读取持久化引擎并执行门禁", async () => {
    const f = await setup(false);
    await expect(
      f.service.resumeSession({ workspacePath: "/workspace", sessionId: "external-session" }),
    ).rejects.toMatchObject({ reasonCode: "engine_not_ready" });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      zcodeProtocolMethods.sessionList,
    ]);
  });
  it("外部已就绪时走原 V4 command 通道，不提升内置 Provider 就绪状态", async () => {
    const f = await setup(true);
    await expect(
      f.service.sendConversationCommandV4({
        workspacePath: "/workspace",
        envelope: sendEnvelope(),
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      zcodeProtocolMethods.sessionList,
      V4_METHODS.command,
    ]);
  });
  it("未就绪的外部会话上传和清理附件不依赖内置 Provider", async () => {
    const f = await setup(false);
    f.request.mockImplementation(async (method) =>
      method === zcodeProtocolMethods.sessionList
        ? { sessions: [{ sessionId: "external-session", engine: "codex" }] }
        : {},
    );
    const target = {
      workspacePath: "/workspace",
      sessionId: "external-session",
      uploadId: "upload",
      __zcodeTrustedV4Connection: { connectionId: "connection", clientMode: "desktop-continuous" },
    };
    await f.service.attachmentBeginV4({
      ...target,
      fileName: "image.png",
      mime: "image/png",
      totalBytes: 1,
      totalChunks: 1,
      checksum: "checksum",
    });
    await f.service.attachmentChunkV4({ ...target, chunkIndex: 0, dataBase64: "aA==" });
    await f.service.attachmentCommitV4(target);
    await f.service.attachmentAbortV4(target);
    expect(f.getStatus).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls
        .filter(([method]) => method !== zcodeProtocolMethods.sessionList)
        .map(([method]) => method),
    ).toEqual([
      V4_METHODS.attachmentBegin,
      V4_METHODS.attachmentChunk,
      V4_METHODS.attachmentCommit,
      V4_METHODS.attachmentAbort,
    ]);
  });
  it("外部会话关闭不依赖登录或内置 Provider", async () => {
    const f = await setup(false);
    f.request.mockImplementation(async (method) =>
      method === zcodeProtocolMethods.sessionList
        ? { sessions: [{ sessionId: "external-session", engine: "codex" }] }
        : { closed: true },
    );
    await expect(
      f.service.closeSession({ workspacePath: "/workspace", sessionId: "external-session" }),
    ).resolves.toBe(true);
    expect(f.getStatus).not.toHaveBeenCalled();
  });
  it("外部会话的 legacy ZCode 专属操作直接说明不支持", async () => {
    const f = await setup(false);
    const target = { workspacePath: "/workspace", sessionId: "external-session" };
    await expect(f.service.setMode({ ...target, mode: "build" })).rejects.toMatchObject({
      code: "external_engine_unsupported",
    });
    await expect(
      f.service.setThoughtLevel({ ...target, thoughtLevel: "high" }),
    ).rejects.toMatchObject({ code: "external_engine_unsupported" });
    await expect(f.service.compactSession(target)).rejects.toMatchObject({
      code: "external_engine_unsupported",
    });
    expect(f.getStatus).not.toHaveBeenCalled();
  });
  it("远程 workspace 拒绝外部引擎，不探测本机官方登录", async () => {
    const f = await setup(true);
    await expect(
      f.service.createSession({
        workspacePath: "/workspace",
        engine: "codex",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/workspace", {
          kind: "ssh",
          host: "test-host",
          username: "test-user",
        }),
      }),
    ).rejects.toMatchObject({ reasonCode: "engine_not_ready" });
    expect(f.getStatus).not.toHaveBeenCalled();
  });
});
