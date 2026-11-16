import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

describe("botsService status", () => {
  it.each(["storage", "refresh", "recovery"] as const)(
    "异步关闭等待已接纳的 %s Repo IO，且不恢复后台同步",
    async (phase) => {
      const entered = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      const repo = f.createMemoryRepo({ version: 3, bots: [] });
      const config = { version: 3 as const, bots: [] };
      const state = {
        version: 3 as const,
        bots: {
          "retained-context": {
            botId: "retained-context",
            workspacePath: "/isolated-workspace",
            mode: "task" as const,
            activeTaskId: "retained-task",
            updatedAt: 1,
          },
        },
      };
      let configReads = 0;
      let stateReads = 0;
      repo.readConfig = vi.fn(async () => {
        configReads += 1;
        if (phase === "storage" || (phase === "refresh" && configReads > 1)) {
          entered.resolve();
          await blocked.promise;
        }
        return config;
      });
      repo.readState = vi.fn(async () => {
        stateReads += 1;
        if (phase === "recovery" && stateReads === 2) {
          entered.resolve();
          await blocked.promise;
        }
        return phase === "recovery" ? state : { version: 3 as const, bots: {} };
      });
      const fetch = vi.fn().mockRejectedValue(new Error("生命周期测试不得发起网络请求"));
      vi.stubGlobal("fetch", fetch);
      const service = f.createBotsService({
        credentialService: f.createCredentialService(),
        repo: repo as never,
      });
      await entered.promise;
      const readsBeforeShutdown = configReads;
      const disposing = service.disposeAllAndWait();
      expect(service.disposeAllAndWait()).toBe(disposing);
      let disposed = false;
      void disposing.then(() => {
        disposed = true;
      });
      try {
        // 单次事件循环检查点只观测可决 Promise；真实 IO 的完成由上面的 deferred 控制。
        await setImmediate();
        expect(disposed).toBe(false);
        blocked.resolve();
        await disposing;
        expect(disposed).toBe(true);
        if (phase === "recovery") expect(configReads).toBe(readsBeforeShutdown);
        const readsAfterShutdown = [configReads, stateReads];
        await setImmediate();
        expect([configReads, stateReads]).toEqual(readsAfterShutdown);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        blocked.resolve();
        await disposing;
      }
    },
  );

  it("启动 Repo 失败保留错误日志，关闭仍幂等且没有未处理 rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const repo = f.createMemoryRepo({ version: 3, bots: [] });
    repo.readConfig = vi.fn(async () => {
      entered.resolve();
      await blocked.promise;
      throw new Error("isolated startup read failed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo: repo as never,
    });
    await entered.promise;
    const disposing = service.disposeAllAndWait();
    try {
      expect(service.disposeAllAndWait()).toBe(disposing);
      blocked.resolve();
      await disposing;
      await setImmediate();
      expect(error).toHaveBeenCalledWith(
        expect.any(String),
        "Bot storage initialization failed: isolated startup read failed",
      );
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      blocked.resolve();
      await disposing;
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it.each(["connection", "task-service"] as const)(
    "群恢复等待 %s 时关闭，晚到结果不能重新建立订阅",
    async (phase) => {
      const entered = Promise.withResolvers<void>();
      const connected = Promise.withResolvers<boolean>();
      const bot = { ...f.feishuConfig.bots[0]!, credentialRef: undefined };
      const repo = f.createMemoryRepo({ version: 3, bots: [bot] }, {
        version: 3,
        bots: {
          group: {
            botId: bot.id,
            workspacePath: "/isolated-workspace",
            workspaceIdentity: "server://isolated/workspace",
            mode: "task",
            activeTaskId: "retained-task",
            updatedAt: 1,
            group: {
              enabled: true,
              ownerId: bot.providerUserId!,
              chatId: "isolated-group",
              authorizationId: "isolated-authorization",
            },
          },
        },
      } as never);
      const tasks = f.createLegacyTaskService();
      const subscribe = vi.fn(() => () => ({ dispose: vi.fn() }));
      tasks.onDynamicTaskEvent = subscribe as never;
      const service = f.createBotsService({
        credentialService: f.createCredentialService(),
        legacyTaskService: tasks,
        repo: repo as never,
        remoteWorkspaceService: {
          isConnected: async () => {
            if (phase === "connection") {
              entered.resolve();
              return connected.promise;
            }
            return true;
          },
          getZCodeTaskService: async () => {
            if (phase === "task-service") {
              entered.resolve();
              await connected.promise;
            }
            return tasks;
          },
        } as never,
      });
      await entered.promise;
      const disposing = service.disposeAllAndWait();
      try {
        connected.resolve(true);
        await disposing;
        expect(subscribe).not.toHaveBeenCalled();
      } finally {
        connected.resolve(true);
        await disposing;
      }
    },
  );

  it("reports bot counts and runtime contexts", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    await service.handleInboundMessage({ botId: "webhook-1", text: "/new", actor });

    await expect(service.getStatus()).resolves.toMatchObject({
      botsCount: 1,
      enabledBotsCount: 1,
      contextsCount: 1,
    });
    await expect(service.getBotStates()).resolves.toMatchObject([
      {
        botId: "webhook-1",
        mode: "draft",
        activeTaskId: null,
      },
    ]);
    service.disposeAll();
  });

  it("returns user-facing /status for a bound bot", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).toContain("工作区");
    expect(replies[0]?.text).not.toContain("Provider:");
    expect(replies[0]?.text).toContain("模型: default");
    service.disposeAll();
  });

  it("returns English /status when the app locale is en-US", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      settingService: f.createSettingService({
        locale: "en-US",
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
          },
        ],
      }),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).toContain("Workspace: workspace");
    expect(replies[0]?.text).toContain("Model: default");
    expect(replies[0]?.text).toContain("Task: draft");
    service.disposeAll();
  });

  it("reports active task model from task/config options", async () => {
    const repo = f.createMemoryRepo(
      {
        ...f.baseConfig,
        bots: [
          {
            ...f.baseConfig.bots[0]!,
            providerUserId: "user-1",
          },
        ],
      },
      {
        version: 3,
        bots: {
          "webhook-1": {
            botId: "webhook-1",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
            workspaceId: "remote:server:test-owner:/tmp/workspace",
            mode: "task",
            activeTaskId: "task-1",
            updatedAt: Date.now(),
          },
        },
      },
    );
    const legacyTaskService = f.createLegacyTaskService();
    legacyTaskService.listTasks = async () => [
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
        provider: "codex",
        model: "meta-model",
        status: "completed",
        traceId: "trace",
        createdAt: 1,
        updatedAt: 1,
        mode: "default",
      },
    ];
    legacyTaskService.getTaskConfigOptions = async () => [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.4",
        options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
      },
    ];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).not.toContain("Provider:");
    expect(replies[0]?.text).toContain("模型: gpt-5.4");
    service.disposeAll();
  });

  it("renders custom provider display name in status model", async () => {
    const providerId = "672a331d-423f-4c83-ab40-93288d9655a6";
    const repo = f.createMemoryRepo(
      {
        ...f.baseConfig,
        bots: [
          {
            ...f.baseConfig.bots[0]!,
            providerUserId: "user-1",
          },
        ],
      },
      {
        version: 3,
        bots: {
          "webhook-1": {
            botId: "webhook-1",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
            workspaceId: "remote:server:test-owner:/tmp/workspace",
            mode: "task",
            activeTaskId: "task-1",
            updatedAt: Date.now(),
          },
        },
      },
    );
    const legacyTaskService = f.createLegacyTaskService();
    legacyTaskService.listTasks = async () => [
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
        provider: "glm",
        model: `${providerId}/deepseek-v4-flash`,
        status: "completed",
        traceId: "trace",
        createdAt: 1,
        updatedAt: 1,
        mode: "yolo",
      },
    ];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      modelSelectionService: f.createModelSelectionService([
        {
          id: providerId,
          name: "DeepSeek",
          endpoints: { baseURL: "https://example.com", paths: {} },
          apiKey: "sk-test",
          models: ["deepseek-v4-flash"],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).toContain("模型: DeepSeek/deepseek-v4-flash");
    expect(replies[0]?.text).not.toContain(`${providerId}/deepseek-v4-flash`);
    service.disposeAll();
  });
});
