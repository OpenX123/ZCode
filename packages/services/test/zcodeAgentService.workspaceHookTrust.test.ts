import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import {
  resolveWorkspaceKey,
  zcodeProtocolMethods,
  type ZCodeRuntimeActivitySnapshot,
} from "@zcode/shared";

type MockWorkspace = { workspacePath: string; workspaceIdentity?: string };

describe("ZCodeAgentService workspace Hook Trust", () => {
  it("没有 task/provider 时只启动 read-only Agent 并发送 workspace grant", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workspaceHookTrustGrant) {
        return { accepted: true };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const getClient = vi.fn(async (_workspace: MockWorkspace) => ({
      request,
      transportKind: "stdio" as const,
      // 根因：workspace grant 也会接线运行事实；未发通知时保持无快照，订阅可释放。
      runtimeActivitySnapshot: undefined,
      onRuntimeActivityChanged: new Emitter<ZCodeRuntimeActivitySnapshot>().event,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        private readonly clients = new Map<string, Awaited<ReturnType<typeof getClient>>>();
        // 1.1 闲置回收：service 取得 client 时续期计时（host-idle-resources-1.1-spec §2）。
        noteActivity() {}
        async getClient(workspace: MockWorkspace) {
          const client = await getClient(workspace);
          this.clients.set(resolveWorkspaceKey(workspace), client);
          return client;
        }
        getExistingClient(workspace: MockWorkspace) {
          return this.clients.get(resolveWorkspaceKey(workspace));
        }
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        disposeAll() {
          this.clients.clear();
        }
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService();

    await expect(
      service.grantWorkspaceHookTrust({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:host:/repo",
        remoteSessionId: "remote-session-1",
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      }),
    ).resolves.toEqual({ accepted: true });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workspaceHookTrustGrant,
      {
        workspace: {
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:host:/repo",
          remoteSessionId: "remote-session-1",
          workspaceKey: "remote:ssh:host:/repo",
        },
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      },
      expect.anything(),
    );
    service.disposeAll();
  });
});
