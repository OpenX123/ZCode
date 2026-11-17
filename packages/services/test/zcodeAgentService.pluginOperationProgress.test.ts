import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodePluginOperationProgressNotification,
  type ZCodeRuntimeActivitySnapshot,
} from "@zcode/shared";

describe("zcodeAgentService Plugin operation progress", () => {
  it("projects a validated Agent progress notification by operationId", async () => {
    let notificationListener:
      | ((notification: { method: string; params?: unknown }) => void)
      | null = null;
    const request = vi.fn(async (method: string) => {
      if (method !== zcodeProtocolMethods.pluginsResolveSuggestedReference) {
        throw new Error(`Unexpected request method: ${method}`);
      }
      notificationListener?.({
        method: zcodeProtocolNotifications.pluginOperationProgress,
        params: { operationId: "suggested-progress", state: "refreshing" },
      });
      return {
        stableId: "document-skills@zcode-plugins-official",
        status: "missing",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      };
    });

    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        // 1.1 闲置回收：service 取得 client 时续期计时（host-idle-resources-1.1-spec §2）。
        noteActivity() {}
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        async getClient() {
          return {
            request,
            transportKind: "stdio",
            // 根因：plugin lane 也要提供可释放的运行事实订阅，不能让进度接线提前中断。
            runtimeActivitySnapshot: undefined,
            onRuntimeActivityChanged: new Emitter<ZCodeRuntimeActivitySnapshot>().event,
            onNotification: (
              listener: (notification: { method: string; params?: unknown }) => void,
            ) => {
              notificationListener = listener;
              return {
                dispose() {
                  if (notificationListener === listener) notificationListener = null;
                },
              };
            },
            onRequest: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
          };
        }
        disposeAll() {}
        async disposeAllAndWait() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService();
    const received: ZCodePluginOperationProgressNotification[] = [];
    const subscription = service.onDynamicPluginOperationProgress("suggested-progress")((event) =>
      received.push(event),
    );

    try {
      await service.resolveSuggestedPluginReference({
        workspacePath: "/workspace",
        stableId: "document-skills@zcode-plugins-official",
        operationId: "suggested-progress",
        clientMode: "desktop-continuous",
        deliveryKind: "desktop-continuous",
      });

      expect(received).toEqual([{ operationId: "suggested-progress", state: "refreshing" }]);

      notificationListener?.({
        method: zcodeProtocolNotifications.pluginOperationProgress,
        params: {
          operationId: "suggested-progress",
          state: "refreshing",
          unexpected: true,
        },
      });
      expect(received).toHaveLength(1);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });
});
