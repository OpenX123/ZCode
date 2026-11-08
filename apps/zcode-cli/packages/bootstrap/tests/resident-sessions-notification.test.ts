// 常驻会话数通知（docs/design/v2/zcode-protocol-agent-server.md「常驻会话数通知」）：Host 回收
// 工作区 CLI 需要“0 个常驻会话”的事实。连接建立时发初始值，会话注册表 record 数每变化一次发一次。
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionId } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeResidentSessionsNotificationSchema,
  type ZCodeResidentSessionsNotification,
} from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("常驻会话数通知", () => {
  it("连接建立发初始 0；创建与关闭会话各发一次整值，序号单调递增", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const apps: Awaited<ReturnType<typeof createRegistryBackedTestApp>>[] = [];
    const server = new ZCodeProtocolAgentServer({
      cwd: process.cwd(),
      sessionStore: store,
      createZCodeApp: async (options) => {
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
    const counts: ZCodeResidentSessionsNotification[] = [];
    server.setNotificationSink((message) => {
      if ("id" in message) {
        if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences)
          void server.handleMessage({
            id: message.id,
            result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
          });
        return;
      }
      if (message.method === zcodeProtocolNotifications.processResidentSessions)
        counts.push(zcodeResidentSessionsNotificationSchema.parse(message.params));
    });
    try {
      expect(counts).toEqual([{ residentSessionCount: 0, sequence: 1 }]);

      const sessionId = createSessionId("resident-count");
      const created = await server.handleMessage({
        id: "create",
        method: V4_METHODS.command,
        params: {
          clientId: "resident-count",
          commandId: "create",
          issuedAt: 1,
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: process.cwd(), sessionId },
        },
      });
      expect(created).toMatchObject({ result: { status: "accepted" } });
      expect(counts.at(-1)).toEqual({ residentSessionCount: 1, sequence: 2 });

      const closed = await server.handleMessage({
        id: "close",
        method: zcodeProtocolMethods.sessionClose,
        params: { sessionId },
      });
      expect(closed, JSON.stringify(closed)).toHaveProperty("result");
      expect(counts.at(-1)).toEqual({ residentSessionCount: 0, sequence: counts.length });
      expect(counts.map((item) => item.sequence)).toEqual(counts.map((_, index) => index + 1));
      expect(counts.map((item) => item.residentSessionCount)).toEqual([0, 1, 0]);
    } finally {
      for (const app of apps) await app.close();
      await server.shutdown();
      store.close();
    }
  });
});
