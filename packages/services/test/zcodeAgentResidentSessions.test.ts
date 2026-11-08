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
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// docs/desktop/host-idle-resources-1.1-spec.md §2「常驻会话数事实」IDLE08–IDLE11：
// CLI 发 process/residentSessions 后，Host 闲置回收守卫改读常驻数，不再按 mayHostSessions 失败关闭。

const createdDirs: string[] = [];
afterEach(() => {
  setDataBaseDir(null);
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 假 CLI：连接建立即发一次常驻数（argv[2]）；session/close 后常驻数归零；
 * argv[3] 给出毫秒数时，在该时刻后自发把常驻数改成 0（模拟常驻池去激活）。
 */
const RESIDENT_FAKE_AGENT = `
let count = Number(process.argv[2] ?? "0");
let sequence = 0;
const emit = () => {
  sequence += 1;
  process.stdout.write(
    JSON.stringify({
      method: "process/residentSessions",
      params: { residentSessionCount: count, sequence },
    }) + "\\n",
  );
};
emit();
const dropAfterMs = Number(process.argv[3] ?? "0");
if (dropAfterMs > 0) setTimeout(() => { count = 0; emit(); }, dropAfterMs);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "session/list" ? { sessions: [] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  if (request.method === "session/close") { count = 0; emit(); }
});
`;

function createSandbox(prefix: string, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  const scriptPath = join(dir, "resident-agent.cjs");
  writeFileSync(scriptPath, RESIDENT_FAKE_AGENT);
  return { dir, command: { command: process.execPath, args: [scriptPath, ...args], cwd: dir } };
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

function createReporter() {
  return { onSpawn: vi.fn(), onReady: vi.fn(), onExit: vi.fn(), onError: vi.fn() };
}

class NotifyingTransport implements ZCodeProtocolTransport {
  readonly kind = "memory" as const;
  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;
  async send(): Promise<void> {}
  notify(params: unknown): void {
    this.messageEmitter.fire({ method: "process/residentSessions", params } as never);
  }
  dispose(): void {
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

describe("ZCodeProtocolClient 常驻会话数", () => {
  it("IDLE11：保存最近一条；sequence 回退与不合法的通知被忽略；变化时通知订阅方", () => {
    const transport = new NotifyingTransport();
    const client = new ZCodeProtocolClient(transport);
    const changes: number[] = [];
    client.onResidentSessionsChanged((count) => changes.push(count));
    expect(client.residentSessionCount).toBeUndefined();

    transport.notify({ residentSessionCount: 2, sequence: 1 });
    expect(client.residentSessionCount).toBe(2);
    transport.notify({ residentSessionCount: 0, sequence: 3 });
    expect(client.residentSessionCount).toBe(0);
    // 回退的 sequence（迟到旧值）与不合法载荷都不能改变已知事实。
    transport.notify({ residentSessionCount: 5, sequence: 2 });
    transport.notify({ residentSessionCount: -1, sequence: 4 });
    transport.notify({ residentSessionCount: 1, sequence: 5, sessionIds: ["leak"] });
    expect(client.residentSessionCount).toBe(0);
    expect(changes).toEqual([2, 0]);
    client.dispose();
  });
});

/** 回收在进程表摘除时同步发布 runtime unavailable；进程树真正退出（onExit）在 Windows 上可能晚 1s 以上。 */
function trackReclaims(service: ReturnType<typeof createReadyService>) {
  const reclaims: number[] = [];
  service.onAgentRuntimeLifecycle?.((event) => {
    if (event.state === "unavailable") reclaims.push(Date.now());
  });
  return reclaims;
}

describe("zcodeAgentService 按常驻会话数回收工作区 CLI", () => {
  it("IDLE08：已收到常驻数 0 时，即使连接发过会话请求也回收", async () => {
    const { dir, command } = createSandbox("zcode-resident-zero-", ["1"]);
    setDataBaseDir(dir);
    const reporter = createReporter();
    const service = createReadyService({
      commandResolver: () => command,
      processLifecycleReporter: reporter,
      sessionIdleTimeoutMs: 250,
    });
    const reclaims = trackReclaims(service);
    try {
      // session/close 带 sessionId：旧近似会永久失败关闭；假 CLI 关闭后常驻数归零。
      await service.closeSession({ workspacePath: dir, sessionId: "session-1" });
      await vi.waitFor(() => expect(reclaims).toHaveLength(1), { timeout: 5_000 });
      await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      expect(reporter.onExit.mock.calls[0]![0]).toMatchObject({
        terminationKind: "expected",
        terminationReason: "idle-timeout",
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("IDLE09：已收到常驻数 > 0 时，只发过无会话读取也不回收", async () => {
    const { dir, command } = createSandbox("zcode-resident-held-", ["1"]);
    setDataBaseDir(dir);
    const service = createReadyService({
      commandResolver: () => command,
      sessionIdleTimeoutMs: 200,
    });
    const reclaims = trackReclaims(service);
    try {
      await service.listSessions({ workspacePath: dir });
      await sleep(800);
      expect(reclaims).toEqual([]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("IDLE10：常驻数由 1 变 0 后无需新请求，闲置窗口后回收", async () => {
    // 常驻数在首个计时到期之后才归零：只有"归零重新计时"才能让进程被回收。
    const { dir, command } = createSandbox("zcode-resident-drop-", ["1", "1200"]);
    setDataBaseDir(dir);
    const service = createReadyService({
      commandResolver: () => command,
      sessionIdleTimeoutMs: 250,
    });
    const reclaims = trackReclaims(service);
    try {
      await service.listSessions({ workspacePath: dir });
      const listedAt = Date.now();
      // 常驻数仍为 1：首个计时到期时守卫拒绝（旧近似此时已按"只发过无会话读取"回收）。
      await sleep(700);
      expect(reclaims).toEqual([]);
      await vi.waitFor(() => expect(reclaims).toHaveLength(1), { timeout: 5_000 });
      expect(reclaims[0]! - listedAt).toBeGreaterThanOrEqual(700);
    } finally {
      await service.disposeAllAndWait();
    }
  });
});
