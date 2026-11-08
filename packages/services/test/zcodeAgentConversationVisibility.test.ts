import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
} from "../src/zcode-agent/zcodeAgent.js";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  withTrustedZCodeAgentV4Connection,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import {
  ZCodeProtocolClient,
  mayRequestHostSessions,
} from "../src/zcode-agent/zcodeProtocolClient.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// docs/desktop/engine-performance-1.1-spec.md「会话可见性上报」VR05/VR06（P3 Host 转发）。

const createdDirs: string[] = [];
afterEach(() => {
  setDataBaseDir(null);
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLIENT_HELLO = {
  kind: "clientHello" as const,
  protocolVersion: 3 as const,
  clientId: "renderer-1",
  appVersion: "4.0.0",
};

function setupFacadeBase() {
  const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const base = {
    reportConversationVisibilityV4: vi.fn(async () => {}),
    setConnectionFlowStateV4: vi.fn(async () => {}),
    onAgentRuntimeLifecycle: vi.fn((listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) =>
      lifecycle.event(listener),
    ),
  } as unknown as IZCodeAgentService;
  return { base, lifecycle };
}

function lifecycleEvent(
  workspacePath: string,
  state: ZCodeAgentRuntimeLifecycleEvent["state"],
): ZCodeAgentRuntimeLifecycleEvent {
  return {
    workspacePath,
    workspaceKey: workspacePath,
    runtimeIdentity: { generation: 2, identity: `${workspacePath}:2:1`, processId: 1 },
    state,
  } as ZCodeAgentRuntimeLifecycleEvent;
}

describe("连接 facade 转发可见性上报", () => {
  it("VR05：握手后注入本连接 connectionId，剥离 Renderer 传入值；超过 64 个拒绝；关闭时发 closed", async () => {
    const { base } = setupFacadeBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-window-1",
      clientMode: "desktop-continuous",
    });
    await expect(
      scope.service.reportConversationVisibilityV4({
        workspacePath: "/repo",
        visibleSessionIds: ["s1"],
      }),
    ).rejects.toThrow("fault.connection.handshakeRequired");

    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4(CLIENT_HELLO);
    await scope.service.reportConversationVisibilityV4({
      workspacePath: "/repo",
      visibleSessionIds: ["s1", "s2"],
      connectionId: "forged",
    } as never);
    const forwarded = vi.mocked(base.reportConversationVisibilityV4).mock.calls[0]![0];
    expect(readTrustedZCodeAgentV4Connection(forwarded)?.connectionId).toBe("conn-window-1");
    expect(forwarded).not.toHaveProperty("connectionId");
    expect(forwarded).toMatchObject({ workspacePath: "/repo", visibleSessionIds: ["s1", "s2"] });

    await expect(
      scope.service.reportConversationVisibilityV4({
        workspacePath: "/repo",
        visibleSessionIds: Array.from({ length: 65 }, (_, index) => `s${index}`),
      }),
    ).rejects.toThrow();
    expect(base.reportConversationVisibilityV4).toHaveBeenCalledTimes(1);

    // 没有订阅、只收过可见性上报的工作区，连接关闭时也要发 closed，让 CLI 删除该连接集合。
    await scope.dispose();
    const closed = vi
      .mocked(base.setConnectionFlowStateV4)
      .mock.calls.map(([params]) => params)
      .filter((params) => params.state === "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ workspacePath: "/repo" });
    expect(readTrustedZCodeAgentV4Connection(closed[0])?.connectionId).toBe("conn-window-1");
  });

  it("VR05：该工作区 runtime unavailable 后撤销登记，关闭时不为它发 closed", async () => {
    const { base, lifecycle } = setupFacadeBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-window-1",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4(CLIENT_HELLO);
    await scope.service.reportConversationVisibilityV4({
      workspacePath: "/repo",
      visibleSessionIds: ["s1"],
    });
    lifecycle.fire(lifecycleEvent("/repo", "unavailable"));
    await scope.dispose();
    expect(base.setConnectionFlowStateV4).not.toHaveBeenCalled();
  });
});

/** 记录收到的每个请求，并对所有请求应答（session/list 返回空列表）。 */
const RECORDING_FAKE_AGENT = `
const { appendFileSync } = require("node:fs");
const log = process.argv[2];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  appendFileSync(log, JSON.stringify({ method: request.method, params: request.params }) + "\\n");
  const result = request.method === "session/list" ? { sessions: [] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`;

function createRecordingSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-visibility-"));
  createdDirs.push(dir);
  const scriptPath = join(dir, "recording-agent.cjs");
  const logPath = join(dir, "requests.log");
  writeFileSync(scriptPath, RECORDING_FAKE_AGENT);
  writeFileSync(logPath, "");
  return {
    dir,
    logPath,
    command: { command: process.execPath, args: [scriptPath, logPath], cwd: dir },
  };
}

function createReadyService(options: Parameters<typeof createZCodeAgentService>[0]) {
  return createZCodeAgentService({
    modelSelectionReadinessSource: {
      async getView() {
        return {
          revision: 1,
          providers: [
            {
              providerId: "glm",
              config: {
                kind: "api" as const,
                api: {
                  type: "openai-chat-completions" as const,
                  baseUrl: "https://provider.test/v1",
                },
                models: ["glm-4.6"],
              },
              models: [{ modelId: "glm-4.6", config: {} }],
            },
          ],
          // 夹具只需满足就绪判定；完整 ModelSelectionView 字段与本测试无关。
        } as never;
      },
    },
    ...options,
  });
}

describe("base service 转发可见性上报", () => {
  it("VR06：CLI 不在时不拉起；CLI 在时发 v4/conversation/visibility，且不阻止闲置回收", async () => {
    const { dir, logPath, command } = createRecordingSandbox();
    setDataBaseDir(dir);
    const commandResolver = vi.fn(() => command);
    const onExit = vi.fn();
    const service = createReadyService({
      commandResolver,
      processLifecycleReporter: {
        onSpawn: vi.fn(),
        onReady: vi.fn(),
        onExit,
        onError: vi.fn(),
      },
      sessionIdleTimeoutMs: 400,
    });
    const trusted = (visibleSessionIds: string[]) =>
      withTrustedZCodeAgentV4Connection(
        { workspacePath: dir, visibleSessionIds },
        { connectionId: "conn-window-1", clientMode: "desktop-continuous" },
      );
    try {
      await expect(service.reportConversationVisibilityV4(trusted(["s1"]))).rejects.toThrow();
      expect(commandResolver).not.toHaveBeenCalled();

      await service.listSessions({ workspacePath: dir });
      await service.reportConversationVisibilityV4(trusted(["s1"]));
      const requests = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: unknown });
      expect(requests.find((request) => request.method === "v4/conversation/visibility")).toEqual({
        method: "v4/conversation/visibility",
        params: { connectionId: "conn-window-1", visibleSessionIds: ["s1"] },
      });
      // 可见性上报既不置位"可能承载会话"，也不续期：只做过无会话读取的 CLI 照常回收。
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(commandResolver).toHaveBeenCalledTimes(1);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("VR06：未携带可信连接的上报被拒绝", async () => {
    const service = createReadyService({});
    try {
      await expect(
        service.reportConversationVisibilityV4({ workspacePath: "/repo", visibleSessionIds: [] }),
      ).rejects.toThrow("fault.visibility.connectionUntrusted");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("VR06：可见性方法列入无会话白名单", () => {
    expect(
      mayRequestHostSessions("v4/conversation/visibility", {
        connectionId: "c",
        visibleSessionIds: ["s1"],
      }),
    ).toBe(false);
    expect(ZCodeProtocolClient).toBeDefined();
  });
});
