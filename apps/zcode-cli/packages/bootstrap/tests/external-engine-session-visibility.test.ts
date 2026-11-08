// 外部引擎闲置关闭的可见性输入（docs/desktop/external-agent-engines-spec.md「可见性输入」P06、P14）：
// Renderer 拥有“会话是否可见”的事实，经 V4 `v4/conversation/visibility` 按连接整体替换上报；
// 协议 server 把它交给本进程的外部引擎进程池作为闲置豁免依据，连接 closed 时删除该连接的上报。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalEngineProcessPool } from "@zcode/adapters/exec";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

const created = vi.hoisted(() => ({ pools: [] as ExternalEngineProcessPool[] }));

vi.mock("@zcode/adapters/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/adapters/exec")>();
  return {
    ...actual,
    createExternalEngineProcessPool: (
      options: Parameters<typeof actual.createExternalEngineProcessPool>[0],
    ) => {
      const pool = actual.createExternalEngineProcessPool(options);
      created.pools.push(pool);
      return pool;
    },
  };
});

const IDLE_FOR_MS = 20 * 60 * 1_000;

function createServer() {
  const server = new ZCodeProtocolAgentServer({
    cwd: process.cwd(),
    createZCodeApp: async () => {
      throw new Error("no session app expected");
    },
  });
  const pool = created.pools.at(-1)!;
  const release = vi.fn(async () => true);
  // 一个已闲置 20 分钟、发过 prompt 的会话连接：不可见时下一次扫描就会关闭。
  pool.trackSession("sess_a", {
    engine: "claude-code",
    readConnection: () => ({ busy: false, resumable: true, lastUsedAt: Date.now() - IDLE_FOR_MS }),
    releaseIdle: release,
  });
  return { server, pool, release };
}

afterEach(async () => {
  for (const pool of created.pools.splice(0)) await pool.close();
});

describe("V4 会话可见性上报接入外部引擎闲置豁免", () => {
  it("可见会话不关闭；连接 closed 后该连接的上报失效，下一次扫描关闭", async () => {
    const { server, pool, release } = createServer();
    const response = await server.handleMessage({
      id: "visibility",
      method: V4_METHODS.conversationVisibility,
      params: { connectionId: "desktop-1", visibleSessionIds: ["sess_a"] },
    });
    expect(response).toEqual({ id: "visibility", result: {} });
    await pool.sweepIdle();
    expect(release).not.toHaveBeenCalled();

    await server.handleMessage({
      id: "flow",
      method: V4_METHODS.connectionFlow,
      params: { connectionId: "desktop-1", state: "closed" },
    });
    await pool.sweepIdle();
    expect(release).toHaveBeenCalledOnce();
    await server.shutdown();
  });

  it("同一连接再次上报整体替换；从未上报的会话按不可见回收", async () => {
    const { server, pool, release } = createServer();
    await server.handleMessage({
      id: "v1",
      method: V4_METHODS.conversationVisibility,
      params: { connectionId: "desktop-1", visibleSessionIds: ["sess_a"] },
    });
    await server.handleMessage({
      id: "v2",
      method: V4_METHODS.conversationVisibility,
      params: { connectionId: "desktop-1", visibleSessionIds: ["sess_other"] },
    });
    await pool.sweepIdle();
    expect(release).toHaveBeenCalledOnce();
    await server.shutdown();
  });

  it("非法载荷返回协议错误且不改变可见集合", async () => {
    const { server, pool, release } = createServer();
    await server.handleMessage({
      id: "ok",
      method: V4_METHODS.conversationVisibility,
      params: { connectionId: "desktop-1", visibleSessionIds: ["sess_a"] },
    });
    const response = await server.handleMessage({
      id: "bad",
      method: V4_METHODS.conversationVisibility,
      params: { connectionId: "desktop-1", visibleSessionIds: [""], extra: true },
    });
    expect(response).toMatchObject({ id: "bad", error: expect.any(Object) });
    await pool.sweepIdle();
    expect(release).not.toHaveBeenCalled();
    await server.shutdown();
  });
});
