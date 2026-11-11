import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelClient, ChannelServer, Emitter, Event, VSBuffer } from "@zcode/rpc";
import type { IMessagePassingProtocol } from "@zcode/rpc";
import {
  connectMobileRemoteLink,
  lookupMobileRemotePairing,
  MobileRemoteConnectError,
} from "@zcode/client";
import {
  generateNoiseKeyPair,
  parseMobileRemotePairingHash,
  type MobileRemoteStatus,
} from "@zcode/shared/mobile-remote";
import { createRelayServer } from "@zcode/relay";
import {
  createMobileRemoteGateway,
  createMobileRemoteStore,
  type MobileRemoteGateway,
  type MobileRemoteHostPort,
} from "../src/main/mobile-remote/index.js";

const TOKEN = "gateway-test-token-0123";
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
}

/** 异步版 waitFor：重试直到 read 不再抛错（中继登记经独立连接异步生效）。 */
async function waitForAsync<T>(read: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** 模拟窗口 Host：每次 attach 新建一个 ChannelServer，暴露 echo 频道。 */
function createFakeHost() {
  const ports: Array<{ closed: boolean; flow: string[]; closeFromHost(): void }> = [];
  const attach = (windowId: number): MobileRemoteHostPort | null => {
    if (windowId !== 1) return null;
    const toServer = new Emitter<VSBuffer>();
    let rpcHandler: ((message: Uint8Array) => void) | null = null;
    const queued: Uint8Array[] = [];
    let closeHandler: (() => void) | null = null;
    const record = {
      closed: false,
      flow: [] as string[],
      closeFromHost() {
        closeHandler?.();
      },
    };
    ports.push(record);
    const protocol: IMessagePassingProtocol = {
      onMessage: toServer.event,
      send(buffer) {
        // 与 MessagePortMain 一致：监听挂上前的消息排队，不丢 Initialize。
        if (rpcHandler) rpcHandler(buffer.buffer);
        else queued.push(buffer.buffer);
      },
    };
    const server = new ChannelServer(protocol, "host");
    server.registerChannel("echo", {
      call: async (_ctx, command, arg) => `${command}:${String(arg)}`,
      listen: () => Event.None,
    });
    return {
      postRpc: (message) => toServer.fire(VSBuffer.wrap(message)),
      postFlowState: (state) => record.flow.push(state),
      onRpc(handler) {
        rpcHandler = handler;
        for (const message of queued.splice(0)) handler(message);
      },
      onClose(handler) {
        closeHandler = handler;
      },
      close() {
        record.closed = true;
        server.dispose();
      },
    };
  };
  return { ports, attach };
}

async function setup() {
  const relay = createRelayServer({ hostToken: TOKEN });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => relay.close(r)));
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "mobile-remote-"));
  const host = createFakeHost();
  const statuses: MobileRemoteStatus[] = [];
  const gateway = createMobileRemoteGateway({
    store: createMobileRemoteStore(dir),
    hostName: () => "Test Mac",
    listWindows: () => [{ windowId: 1, title: "ZCode", focused: true }],
    attachWindow: host.attach,
    logger: { info: () => {}, warn: () => {} },
    onStatusChanged: (status) => statuses.push(status),
    reconnectDelaysMs: [20],
  });
  cleanups.push(() => gateway.dispose());
  await gateway.start();
  await gateway.setConfig({ enabled: true, relayUrl, relayToken: TOKEN });
  await waitFor(() => gateway.getStatus().relay === "online");
  return { relayUrl, dir, host, gateway, statuses };
}

async function connectPhone(
  ctx: { relayUrl: string; gateway: MobileRemoteGateway },
  options: { deviceKey?: ReturnType<typeof generateNoiseKeyPair>; pairingCode?: string } = {},
) {
  const link = await connectMobileRemoteLink(
    {
      relayUrl: ctx.relayUrl,
      hostId: ctx.gateway.getStatus().hostId,
      deviceKey: options.deviceKey ?? generateNoiseKeyPair(),
      deviceName: "Phone",
      ...(options.pairingCode ? { pairingCode: options.pairingCode } : {}),
      chooseWindow: (windows) => windows[0]?.windowId ?? null,
      timeoutMs: 3000,
    },
    (protocol) => new ChannelClient(protocol),
  );
  cleanups.push(() => link.close());
  return link;
}

function pairingCodeOf(gateway: MobileRemoteGateway): string {
  const ticket = gateway.createPairing();
  return parseMobileRemotePairingHash(new URL(ticket.url).hash)!.pairingCode;
}

describe("mobile remote gateway", () => {
  it("扫码配对后 RPC 经中继与加密通道到达窗口 Host 并返回", async () => {
    const ctx = await setup();
    const deviceKey = generateNoiseKeyPair();
    const link = await connectPhone(ctx, { deviceKey, pairingCode: pairingCodeOf(ctx.gateway) });

    expect(link.hostName).toBe("Test Mac");
    expect(link.windowId).toBe(1);
    await expect(link.bound.getChannel("echo").call("say", "hi")).resolves.toBe("say:hi");

    const status = await waitFor(() => {
      const current = ctx.gateway.getStatus();
      return current.devices[0]?.connected ? current : undefined;
    });
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]!.name).toBe("Phone");
  });

  it("配对码一次性：同一配对码第二台设备被拒绝；已配对设备无需配对码可重连", async () => {
    const ctx = await setup();
    const code = pairingCodeOf(ctx.gateway);
    const deviceKey = generateNoiseKeyPair();
    const first = await connectPhone(ctx, { deviceKey, pairingCode: code });
    first.close();

    await expect(connectPhone(ctx, { pairingCode: code })).rejects.toMatchObject({
      code: "unknown_device",
    });
    const again = await connectPhone(ctx, { deviceKey });
    await expect(again.bound.getChannel("echo").call("ping", 1)).resolves.toBe("ping:1");
  });

  it("未配对且无配对码的设备被拒绝", async () => {
    const ctx = await setup();
    const error = await connectPhone(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MobileRemoteConnectError);
    expect((error as MobileRemoteConnectError).code).toBe("unknown_device");
  });

  it("过期配对码被拒绝", async () => {
    let clock = 1_000_000;
    const relay = createRelayServer({ hostToken: TOKEN });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise((r) => relay.close(r)));
    const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    const gateway = createMobileRemoteGateway({
      store: createMobileRemoteStore(await mkdtemp(join(tmpdir(), "mobile-remote-"))),
      hostName: () => "Mac",
      listWindows: () => [{ windowId: 1, title: "ZCode", focused: true }],
      attachWindow: createFakeHost().attach,
      logger: { info: () => {}, warn: () => {} },
      now: () => clock,
      pairingTtlMs: 1000,
    });
    cleanups.push(() => gateway.dispose());
    await gateway.start();
    await gateway.setConfig({ enabled: true, relayUrl, relayToken: TOKEN });
    await waitFor(() => gateway.getStatus().relay === "online");
    const code = pairingCodeOf(gateway);
    clock += 2000;
    await expect(connectPhone({ relayUrl, gateway }, { pairingCode: code })).rejects.toMatchObject({
      code: "unknown_device",
    });
  });

  it("移除设备后现有连接立即断开，之后无法再连", async () => {
    const ctx = await setup();
    const deviceKey = generateNoiseKeyPair();
    const link = await connectPhone(ctx, { deviceKey, pairingCode: pairingCodeOf(ctx.gateway) });
    const closed = new Promise<{ error?: string }>((resolve) => link.onClose(resolve));
    const deviceId = ctx.gateway.getStatus().devices[0]!.id;
    await ctx.gateway.revokeDevice(deviceId);
    expect((await closed).error).toBe("unknown_device");
    await expect(connectPhone(ctx, { deviceKey })).rejects.toMatchObject({
      code: "unknown_device",
    });
    expect(ctx.host.ports[0]!.closed).toBe(true);
  });

  it("窗口 Host 端口关闭时手机连接以窗口不可用关闭", async () => {
    const ctx = await setup();
    const link = await connectPhone(ctx, { pairingCode: pairingCodeOf(ctx.gateway) });
    const closed = new Promise<{ error?: string }>((resolve) => link.onClose(resolve));
    ctx.host.ports[0]!.closeFromHost();
    expect((await closed).error).toBe("window_unavailable");
  });

  it("手机断开后网关关闭 Host attachment 端口", async () => {
    const ctx = await setup();
    const link = await connectPhone(ctx, { pairingCode: pairingCodeOf(ctx.gateway) });
    link.close();
    await waitFor(() => ctx.host.ports[0]!.closed);
  });

  it("中继令牌错误时状态为离线并给出原因", async () => {
    const ctx = await setup();
    await ctx.gateway.setConfig({
      enabled: true,
      relayUrl: ctx.relayUrl,
      relayToken: "wrong-token",
    });
    const status = await waitFor(() => {
      const current = ctx.gateway.getStatus();
      return current.lastError === "中继令牌错误" ? current : undefined;
    });
    expect(status.relay).toBe("offline");
  });

  it("关闭开关后断开中继与现有手机连接", async () => {
    const ctx = await setup();
    const link = await connectPhone(ctx, { pairingCode: pairingCodeOf(ctx.gateway) });
    const closed = new Promise((resolve) => link.onClose(resolve));
    await ctx.gateway.setConfig({ enabled: false, relayUrl: ctx.relayUrl });
    await closed;
    expect(ctx.gateway.getStatus().relay).toBe("disabled");
    expect(() => ctx.gateway.createPairing()).toThrow();
  });

  it("状态文件权限为 0600，重启后主机身份与设备保持不变", async () => {
    const ctx = await setup();
    await connectPhone(ctx, { pairingCode: pairingCodeOf(ctx.gateway) });
    const before = ctx.gateway.getStatus();
    const file = join(ctx.dir, "state.json");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(file, "utf8")).not.toContain(before.hostName);
    const reloaded = await createMobileRemoteStore(ctx.dir).load();
    expect(reloaded.devices.map((d) => d.id)).toEqual(before.devices.map((d) => d.id));
    expect(reloaded.relayToken).toBe(TOKEN);
  });

  it("手输配对码：经中继查到 hostId 后完成配对，配对成功后查询失效", async () => {
    const ctx = await setup();
    const ticket = ctx.gateway.createPairing();
    expect(ticket.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const typed = ticket.code.toLowerCase().replace("-", " ");
    const { hostId } = await waitForAsync(() => lookupMobileRemotePairing(ctx.relayUrl, typed));
    expect(hostId).toBe(ctx.gateway.getStatus().hostId);

    const link = await connectPhone(ctx, { pairingCode: typed });
    await expect(link.bound.getChannel("echo").call("say", "ok")).resolves.toBe("say:ok");
    await waitForAsync(async () => {
      const error = await lookupMobileRemotePairing(ctx.relayUrl, typed).catch((e: unknown) => e);
      if ((error as MobileRemoteConnectError).code !== "pairing_not_found")
        throw new Error("still offered");
    });
  });

  it("同一配对码累计输错 5 次后作废，正确码也无法再配对", async () => {
    const ctx = await setup();
    const code = pairingCodeOf(ctx.gateway);
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 5; i += 1) {
      await expect(connectPhone(ctx, { pairingCode: wrong })).rejects.toMatchObject({
        code: "unknown_device",
      });
    }
    await expect(connectPhone(ctx, { pairingCode: code })).rejects.toMatchObject({
      code: "unknown_device",
    });
    await expect(lookupMobileRemotePairing(ctx.relayUrl, code)).rejects.toMatchObject({
      code: "pairing_not_found",
    });
  });

  it("重新生成配对码后旧码失效，中继只登记新码", async () => {
    const ctx = await setup();
    const first = pairingCodeOf(ctx.gateway);
    const second = pairingCodeOf(ctx.gateway);
    await waitForAsync(() => lookupMobileRemotePairing(ctx.relayUrl, second));
    await expect(lookupMobileRemotePairing(ctx.relayUrl, first)).rejects.toMatchObject({
      code: "pairing_not_found",
    });
    await expect(connectPhone(ctx, { pairingCode: first })).rejects.toMatchObject({
      code: "unknown_device",
    });
  });

  it("中继重启后网关重新登记仍有效的配对码", async () => {
    const relay = createRelayServer({ hostToken: TOKEN });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const port = (relay.address() as AddressInfo).port;
    const relayUrl = `http://127.0.0.1:${port}`;
    const gateway = createMobileRemoteGateway({
      store: createMobileRemoteStore(await mkdtemp(join(tmpdir(), "mobile-remote-"))),
      hostName: () => "Mac",
      listWindows: () => [{ windowId: 1, title: "ZCode", focused: true }],
      attachWindow: createFakeHost().attach,
      logger: { info: () => {}, warn: () => {} },
      reconnectDelaysMs: [20],
    });
    cleanups.push(() => gateway.dispose());
    await gateway.start();
    await gateway.setConfig({ enabled: true, relayUrl, relayToken: TOKEN });
    await waitFor(() => gateway.getStatus().relay === "online");
    const code = pairingCodeOf(gateway);
    await waitForAsync(() => lookupMobileRemotePairing(relayUrl, code));

    await new Promise((r) => relay.close(r));
    await waitFor(() => gateway.getStatus().relay !== "online");
    const restarted = createRelayServer({ hostToken: TOKEN });
    await new Promise<void>((r) => restarted.listen(port, "127.0.0.1", r));
    cleanups.push(() => new Promise((r) => restarted.close(r)));
    await waitFor(() => gateway.getStatus().relay === "online");
    const { hostId } = await waitForAsync(() => lookupMobileRemotePairing(relayUrl, code));
    expect(hostId).toBe(gateway.getStatus().hostId);
  });
});
