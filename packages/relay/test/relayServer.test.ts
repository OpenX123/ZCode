import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  MobileRemoteInitiatorHandshake,
  MobileRemoteResponderHandshake,
  bytesToBase64Url,
  generateNoiseKeyPair,
  mobileRemotePairingLookupKey,
  type SecureChannel,
} from "@zcode/shared/mobile-remote";
import { RelayCloseCodes, createRelayServer } from "../src/index.js";

const TOKEN = "test-token-0123456789";
const servers: Array<ReturnType<typeof createRelayServer>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function startRelay(options: Partial<Parameters<typeof createRelayServer>[0]> = {}) {
  const server = createRelayServer({ hostToken: TOKEN, ...options });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

function open(url: string): WebSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";
  sockets.push(ws);
  return ws;
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

function nextMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => ws.once("message", (data) => resolve(data as Buffer)));
}

/** 模拟桌面网关：注册控制连接，收到 incoming 后 accept 并完成 responder 握手。 */
async function startHost(base: string, hostKey = generateNoiseKeyPair()) {
  const hostId = bytesToBase64Url(hostKey.publicKey);
  const control = open(`${base}/v1/host?host=${hostId}&token=${TOKEN}`);
  await opened(control);
  const channels: Promise<SecureChannel>[] = [];
  const accepted: WebSocket[] = [];
  control.on("message", (raw) => {
    const { connId } = JSON.parse(String(raw)) as { connId: string };
    const ws = open(`${base}/v1/accept?host=${hostId}&conn=${connId}&token=${TOKEN}`);
    accepted.push(ws);
    channels.push(
      new Promise((resolve) => {
        const hs = new MobileRemoteResponderHandshake({
          staticKey: hostKey,
          write: (d) => ws.send(d),
        });
        let step = 0;
        let channel: SecureChannel | null = null;
        ws.on("message", (data: Buffer) => {
          const bytes = new Uint8Array(data);
          if (step === 0) {
            ws.send(hs.respond(bytes));
            step = 1;
          } else if (step === 1) {
            channel = hs.finish(bytes).channel;
            step = 2;
            resolve(channel);
          } else {
            channel?.receive(bytes);
          }
        });
      }),
    );
  });
  return { hostKey, hostId, control, channels, accepted };
}

async function connectPhone(base: string, hostId: string, hostKey: Uint8Array) {
  const ws = open(`${base}/v1/connect?host=${hostId}`);
  await opened(ws);
  const hs = new MobileRemoteInitiatorHandshake({
    staticKey: generateNoiseKeyPair(),
    expectedHostKey: hostKey,
    hello: { type: "hello", protocolVersion: 1, deviceName: "phone" },
    write: (d) => ws.send(d),
  });
  ws.send(hs.start());
  const message2 = await nextMessage(ws);
  const { message, channel } = hs.finish(new Uint8Array(message2));
  ws.send(message);
  ws.on("message", (data: Buffer) => channel.receive(new Uint8Array(data)));
  return { ws, channel };
}

describe("relay server", () => {
  it("对接手机与主机，加密 RPC 双向可达", async () => {
    const { base } = await startRelay();
    const host = await startHost(base);
    const phone = await connectPhone(base, host.hostId, host.hostKey.publicKey);
    const hostChannel = await host.channels[0]!;

    const atHost = new Promise<Uint8Array>((resolve) =>
      hostChannel.setHandlers({ onRpc: resolve, onControl: () => {} }),
    );
    const atPhone = new Promise<Uint8Array>((resolve) =>
      phone.channel.setHandlers({ onRpc: resolve, onControl: () => {} }),
    );
    phone.channel.sendRpc(new Uint8Array([1, 2, 3]));
    hostChannel.sendRpc(new Uint8Array([4, 5]));
    expect(await atHost).toEqual(new Uint8Array([1, 2, 3]));
    expect(await atPhone).toEqual(new Uint8Array([4, 5]));
  });

  it("主机不在线时手机连接以 4404 关闭", async () => {
    const { base } = await startRelay();
    const hostId = bytesToBase64Url(generateNoiseKeyPair().publicKey);
    const ws = open(`${base}/v1/connect?host=${hostId}`);
    expect(await closed(ws)).toBe(RelayCloseCodes.hostOffline);
  });

  it("令牌错误时拒绝主机注册", async () => {
    const { base } = await startRelay();
    const hostId = bytesToBase64Url(generateNoiseKeyPair().publicKey);
    const ws = open(`${base}/v1/host?host=${hostId}&token=wrong`);
    const error = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(error.message).toContain("401");
  });

  it("主机迟迟不 accept 时手机连接超时关闭", async () => {
    const { base } = await startRelay({ acceptTimeoutMs: 50 });
    const hostKey = generateNoiseKeyPair();
    const hostId = bytesToBase64Url(hostKey.publicKey);
    const control = open(`${base}/v1/host?host=${hostId}&token=${TOKEN}`);
    await opened(control);
    const ws = open(`${base}/v1/connect?host=${hostId}`);
    expect(await closed(ws)).toBe(RelayCloseCodes.acceptTimeout);
  });

  it("同一主机重复注册时旧控制连接被替换", async () => {
    const { base } = await startRelay();
    const hostKey = generateNoiseKeyPair();
    const first = await startHost(base, hostKey);
    const firstClosed = closed(first.control);
    const second = await startHost(base, hostKey);
    expect(await firstClosed).toBe(RelayCloseCodes.hostReplaced);
    const phone = await connectPhone(base, second.hostId, hostKey.publicKey);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("超过单主机并发上限时拒绝新连接", async () => {
    const { base } = await startRelay({ maxConnectionsPerHost: 1 });
    const host = await startHost(base);
    await connectPhone(base, host.hostId, host.hostKey.publicKey);
    const extra = open(`${base}/v1/connect?host=${host.hostId}`);
    expect(await closed(extra)).toBe(RelayCloseCodes.tooManyConnections);
  });

  it("一端关闭时另一端随之关闭", async () => {
    const { base } = await startRelay();
    const host = await startHost(base);
    const phone = await connectPhone(base, host.hostId, host.hostKey.publicKey);
    await host.channels[0];
    const hostSide = closed(host.accepted[0]!);
    phone.ws.close(4001, "bye");
    expect(await hostSide).toBe(4001);
  });

  it("托管手机网页并阻止路径穿越", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-static-"));
    await writeFile(join(dir, "index.html"), "<html>mobile</html>");
    await writeFile(join(dir, "app.js"), "console.log(1)");
    const { http } = await startRelay({ staticDir: dir });
    const index = await fetch(`${http}/m/`);
    expect(await index.text()).toBe("<html>mobile</html>");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const js = await fetch(`${http}/m/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    const traversal = await fetch(`${http}/m/..%2F..%2Fetc%2Fpasswd`);
    expect(await traversal.text()).toBe("<html>mobile</html>");
    const root = await fetch(`${http}/`, { redirect: "manual" });
    expect(root.headers.get("location")).toBe("/m/");
  });

  describe("配对码查询", () => {
    const lookup = mobileRemotePairingLookupKey("K7M2-9QXD");

    async function offer(control: WebSocket, message: unknown): Promise<void> {
      control.send(JSON.stringify(message));
      // 控制消息与随后的 HTTP 查询走不同连接，等中继处理完再查。
      await new Promise((r) => setTimeout(r, 30));
    }

    it("主机登记后可查到 hostId；撤销后 404", async () => {
      const { base, http } = await startRelay();
      const host = await startHost(base);
      await offer(host.control, { type: "pairing-offer", lookup, expiresAt: Date.now() + 60_000 });
      const hit = await fetch(`${http}/v1/pair/${lookup}`);
      expect(hit.status).toBe(200);
      expect(hit.headers.get("cache-control")).toBe("no-store");
      expect(await hit.json()).toEqual({ hostId: host.hostId });

      await offer(host.control, { type: "pairing-clear" });
      expect((await fetch(`${http}/v1/pair/${lookup}`)).status).toBe(404);
    });

    it("新登记覆盖旧登记；过期登记查不到；非法消息被忽略", async () => {
      const { base, http } = await startRelay();
      const host = await startHost(base);
      const other = mobileRemotePairingLookupKey("ABCD-EFGH");
      await offer(host.control, { type: "pairing-offer", lookup, expiresAt: Date.now() + 60_000 });
      await offer(host.control, {
        type: "pairing-offer",
        lookup: other,
        expiresAt: Date.now() + 60_000,
      });
      expect((await fetch(`${http}/v1/pair/${lookup}`)).status).toBe(404);
      expect((await fetch(`${http}/v1/pair/${other}`)).status).toBe(200);

      await offer(host.control, {
        type: "pairing-offer",
        lookup: "bad",
        expiresAt: Date.now() + 60_000,
      });
      await offer(host.control, "not json");
      expect((await fetch(`${http}/v1/pair/${other}`)).status).toBe(200);

      await offer(host.control, { type: "pairing-offer", lookup, expiresAt: Date.now() - 1 });
      expect((await fetch(`${http}/v1/pair/${lookup}`)).status).toBe(404);
    });

    it("主机控制连接断开后登记随之清除", async () => {
      const { base, http } = await startRelay();
      const host = await startHost(base);
      await offer(host.control, { type: "pairing-offer", lookup, expiresAt: Date.now() + 60_000 });
      host.control.close();
      await closed(host.control);
      await new Promise((r) => setTimeout(r, 30));
      expect((await fetch(`${http}/v1/pair/${lookup}`)).status).toBe(404);
    });

    it("同一客户端未命中过多返回 429，命中不计数", async () => {
      const { base, http } = await startRelay({ pairingMissesPerMinute: 2 });
      const host = await startHost(base);
      await offer(host.control, { type: "pairing-offer", lookup, expiresAt: Date.now() + 60_000 });
      expect((await fetch(`${http}/v1/pair/${lookup}`)).status).toBe(200);
      const miss = mobileRemotePairingLookupKey("ZZZZ-ZZZZ");
      expect((await fetch(`${http}/v1/pair/${miss}`)).status).toBe(404);
      expect((await fetch(`${http}/v1/pair/${miss}`)).status).toBe(404);
      const limited = await fetch(`${http}/v1/pair/${lookup}`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
    });

    it("trustProxy 时按 X-Forwarded-For 最后一跳限流，伪造的前缀不影响", async () => {
      const { http } = await startRelay({ trustProxy: true, pairingMissesPerMinute: 1 });
      const miss = mobileRemotePairingLookupKey("ZZZZ-ZZZZ");
      const as = (forwarded: string) =>
        fetch(`${http}/v1/pair/${miss}`, { headers: { "x-forwarded-for": forwarded } });
      expect((await as("1.1.1.1, 10.0.0.1")).status).toBe(404);
      // 同一真实客户端（最后一跳相同）伪造不同前缀仍被限流。
      expect((await as("2.2.2.2, 10.0.0.1")).status).toBe(429);
      expect((await as("10.0.0.2")).status).toBe(404);
    });
  });
});
