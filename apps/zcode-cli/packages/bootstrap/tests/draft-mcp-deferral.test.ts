// P10（docs/desktop/engine-performance-1.1-spec.md §1「草稿不触发 MCP」）：升级后首启 manifest 缓存
// 未命中时，7 个从未发送的草稿拉起了 28 个 MCP 进程。协议 server 只给 deferred 持久化的草稿写入
// deferMcpStartupUntilFirstUse，已持久化创建保持构造即登记 MCP。
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionId } from "@zcode/contracts";
import { zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("草稿推迟 MCP 启动（协议 server）", () => {
  it("V4 草稿 createSession 写入推迟标记；legacy 立即持久化的创建不写", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const apps: Awaited<ReturnType<typeof createRegistryBackedTestApp>>[] = [];
    const runtimeConfigs: Array<Record<string, unknown> | undefined> = [];
    const server = new ZCodeProtocolAgentServer({
      cwd: process.cwd(),
      sessionStore: store,
      createZCodeApp: async (options) => {
        runtimeConfigs.push(options.runtimeConfig as Record<string, unknown> | undefined);
        const app = await createRegistryBackedTestApp({
          ...options,
          env: {},
          skipUserConfig: true,
          providerRegistry: createTestProviderRegistry([
            { providerId: "provider-a", modelId: "model-a" },
          ]),
        });
        apps.push(app);
        return app;
      },
    });
    server.setNotificationSink((message) => {
      if (
        "id" in message &&
        message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
      ) {
        void server.handleMessage({
          id: message.id,
          result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
        });
      }
    });
    try {
      const draft = await server.handleMessage({
        id: "draft",
        method: V4_METHODS.command,
        params: {
          clientId: "draft-mcp",
          commandId: "draft",
          issuedAt: 1,
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: process.cwd() },
        },
      });
      expect(draft).toMatchObject({ result: { status: "accepted" } });
      expect(runtimeConfigs[0]).toMatchObject({ deferMcpStartupUntilFirstUse: true });

      const legacy = await server.handleMessage({
        id: "legacy",
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          sessionId: createSessionId("draft-mcp-legacy"),
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
        },
      });
      expect(legacy, JSON.stringify(legacy)).toHaveProperty("result");
      expect(runtimeConfigs[1]).not.toHaveProperty("deferMcpStartupUntilFirstUse");
    } finally {
      for (const app of apps) await app.close();
      await server.shutdown();
      store.close();
    }
  });
});
