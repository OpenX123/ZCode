import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "../src/zcode-agent/zcodeProtocolTransport.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// docs/desktop/host-idle-resources-1.1-spec.md §2/§3：会话通道与插件管理通道 CLI 闲置回收。

const createdDirs: string[] = [];
afterEach(() => {
  setDataBaseDir(null);
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 对每个请求立即应答；session/list、plugins/list 返回满足 schema 的空结果。 */
const ECHO_FAKE_AGENT = `
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result =
    request.method === "session/list"
      ? { sessions: [] }
      : request.method === "plugins/list"
        ? { plugins: [], diagnostics: [] }
        : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`;

function createSandbox(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  const scriptPath = join(dir, "echo-agent.cjs");
  writeFileSync(scriptPath, ECHO_FAKE_AGENT);
  return { dir, command: { command: process.execPath, args: [scriptPath], cwd: dir } };
}

class FakeTransport implements ZCodeProtocolTransport {
  readonly kind = "memory" as const;
  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;
  async send(message: ZCodeProtocolMessage): Promise<void> {
    if ("id" in message && "method" in message)
      queueMicrotask(() => this.messageEmitter.fire({ id: message.id, result: {} }));
  }
  dispose(): void {
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

describe("ZCodeProtocolClient.mayHostSessions", () => {
  it.each([
    ["workspace/readPresentation", { workspace: { workspacePath: "/w" } }],
    ["session/list", { workspace: { workspacePath: "/w" }, limit: 20 }],
    ["provider/refreshRegistry", {}],
    ["v4/conversation/subscribe", { topic: "sessions-index/w", connectionId: "c" }],
    ["v4/conversation/subscribe", { topic: "workspace-config/w", connectionId: "c" }],
    ["v4/commands/query", { clock: true }],
  ])("无会话读取 %s 不置位", async (method, params) => {
    const client = new ZCodeProtocolClient(new FakeTransport());
    await client.request(method as never, params);
    expect(client.mayHostSessions).toBe(false);
    client.dispose();
  });

  it.each([
    ["v4/conversation/subscribe", { topic: "conversation/s1", connectionId: "c" }],
    ["session/close", { sessionId: "s1" }],
    ["v4/command", { type: "createSession", payload: { config: {} } }],
    ["session/create", { workspace: { workspacePath: "/w" } }],
    // 白名单方法带会话标识时同样按会话分道处理。
    ["skills/referenceCatalog", { workspace: { workspacePath: "/w" }, sessionId: "s1" }],
    // 未知方法失败关闭。
    ["future/unknownMethod", {}],
  ])("可能让会话常驻的 %s 置位", async (method, params) => {
    const client = new ZCodeProtocolClient(new FakeTransport());
    await client.request(method as never, params);
    expect(client.mayHostSessions).toBe(true);
    client.dispose();
  });

  it("观测请求不置位", async () => {
    const client = new ZCodeProtocolClient(new FakeTransport());
    await client.request("future/unknownMethod" as never, {}, undefined, {
      lifecycle: "observation",
    });
    expect(client.mayHostSessions).toBe(false);
    client.dispose();
  });
});

describe("ZCodeAgentProcessManager 闲置回收守卫与活动续期", () => {
  it("守卫拒绝时不回收；守卫事实变化后经 noteActivity 重新计时并回收", async () => {
    const { dir, command } = createSandbox("zcode-idle-guard-");
    let allow = false;
    const manager = new ZCodeAgentProcessManager({
      idleTimeoutMs: 150,
      idleReclaimGuard: () => allow,
      commandResolver: () => command,
    });
    try {
      const client = await manager.getClient({ workspacePath: dir });
      await client.request("workspace/readState" as never, {});
      await sleep(450);
      expect(client.isDisposed).toBe(false);
      allow = true;
      manager.noteActivity({ workspacePath: dir });
      await vi.waitFor(() => expect(client.isDisposed).toBe(true), { timeout: 3_000 });
    } finally {
      await manager.disposeAllAndWait();
    }
  });

  it("取得已有 client 视为活动，闲置计时从最后一次取得起算", async () => {
    const { dir, command } = createSandbox("zcode-idle-touch-");
    const manager = new ZCodeAgentProcessManager({
      idleTimeoutMs: 600,
      commandResolver: () => command,
    });
    try {
      const client = await manager.getClient({ workspacePath: dir });
      await client.request("workspace/readState" as never, {});
      await sleep(400);
      // 取得 client 后到真正发请求之间可能还有其它异步准备；这段空档不能被回收打断。
      expect(await manager.getClient({ workspacePath: dir })).toBe(client);
      await sleep(400);
      expect(client.isDisposed).toBe(false);
      await vi.waitFor(() => expect(client.isDisposed).toBe(true), { timeout: 3_000 });
    } finally {
      await manager.disposeAllAndWait();
    }
  });
});

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
        };
      },
    },
    ...options,
  });
}

function createReporter() {
  return { onSpawn: vi.fn(), onReady: vi.fn(), onExit: vi.fn(), onError: vi.fn() };
}

describe("zcodeAgentService 通道闲置回收", () => {
  it("只服务过无会话读取的工作区 CLI 闲置后回收，下一次请求透明拉起新一代", async () => {
    const { dir, command } = createSandbox("zcode-chat-idle-");
    setDataBaseDir(dir);
    const commandResolver = vi.fn(() => command);
    const reporter = createReporter();
    const lifecycle: string[] = [];
    const service = createReadyService({
      commandResolver,
      processLifecycleReporter: reporter,
      sessionIdleTimeoutMs: 300,
    });
    service.onAgentRuntimeLifecycle?.((event) => lifecycle.push(event.state));
    try {
      await service.listSessions({ workspacePath: dir });
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        terminationKind: "expected",
        terminationReason: "idle-timeout",
      });
      expect(lifecycle).toEqual(["available", "unavailable"]);
      await expect(service.listSessions({ workspacePath: dir })).resolves.toEqual([]);
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("承载过会话的工作区 CLI 不被 Host 回收（常驻会话事实不可得时失败关闭）", async () => {
    const { dir, command } = createSandbox("zcode-chat-hosted-");
    setDataBaseDir(dir);
    const reporter = createReporter();
    const service = createReadyService({
      commandResolver: () => command,
      processLifecycleReporter: reporter,
      sessionIdleTimeoutMs: 200,
    });
    try {
      await service.closeSession({ workspacePath: dir, sessionId: "session-1" });
      await service.listSessions({ workspacePath: dir });
      await sleep(700);
      expect(reporter.onExit).not.toHaveBeenCalled();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("插件管理通道 CLI 闲置后回收，下一次插件请求重新拉起", async () => {
    const { dir, command } = createSandbox("zcode-plugin-idle-");
    setDataBaseDir(dir);
    const commandResolver = vi.fn(() => command);
    const service = createReadyService({ commandResolver, pluginIdleTimeoutMs: 300 });
    try {
      await service.listPlugins({ workspacePath: dir });
      expect(commandResolver).toHaveBeenCalledTimes(1);
      await sleep(900);
      await service.listPlugins({ workspacePath: dir });
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });
});
