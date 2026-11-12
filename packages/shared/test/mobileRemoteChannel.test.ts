import { describe, expect, it } from "vitest";
import {
  MOBILE_REMOTE_MAX_FRAME_PLAINTEXT,
  MobileRemoteInitiatorHandshake,
  MobileRemoteResponderHandshake,
  NoiseError,
  buildMobileRemotePairingUrl,
  bytesToBase64Url,
  generateNoiseKeyPair,
  parseMobileRemotePairingHash,
  relayWebSocketUrl,
  type MobileRemoteControl,
  type SecureChannel,
} from "../src/mobile-remote/index.js";

const hello = { type: "hello", protocolVersion: 1, deviceName: "iPhone" } as const;

/** 内存中模拟一条 relay 管道：记录所有经过的密文，供「中继只见密文」断言使用。 */
function connect(options?: { expectedHostKey?: Uint8Array; pairingCode?: string }) {
  const hostKey = generateNoiseKeyPair();
  const deviceKey = generateNoiseKeyPair();
  const wire: Uint8Array[] = [];
  const toHost: Uint8Array[] = [];
  const toPhone: Uint8Array[] = [];
  const responder = new MobileRemoteResponderHandshake({
    staticKey: hostKey,
    write: (data) => {
      wire.push(data);
      toPhone.push(data);
    },
  });
  const initiator = new MobileRemoteInitiatorHandshake({
    staticKey: deviceKey,
    expectedHostKey: options?.expectedHostKey ?? hostKey.publicKey,
    hello: { ...hello, ...(options?.pairingCode ? { pairingCode: options.pairingCode } : {}) },
    write: (data) => {
      wire.push(data);
      toHost.push(data);
    },
  });
  const m1 = initiator.start();
  const m2 = responder.respond(m1);
  const phone = initiator.finish(m2);
  const host = responder.finish(phone.message);
  wire.push(m1, m2, phone.message);
  return { hostKey, deviceKey, wire, toHost, toPhone, phone: phone.channel, host };
}

function collect(channel: SecureChannel) {
  const rpc: Uint8Array[] = [];
  const control: MobileRemoteControl[] = [];
  channel.setHandlers({ onRpc: (m) => rpc.push(m), onControl: (m) => control.push(m) });
  return { rpc, control };
}

function deliver(queue: Uint8Array[], channel: SecureChannel) {
  for (const data of queue.splice(0)) channel.receive(data);
}

describe("mobile remote secure channel", () => {
  it("完成 XX 握手：主机拿到设备公钥与 hello，双方互通 RPC 与控制消息", () => {
    const link = connect({ pairingCode: "code-1234567890abcdef" });
    expect(link.host.deviceKey).toEqual(link.deviceKey.publicKey);
    expect(link.host.hello.pairingCode).toBe("code-1234567890abcdef");

    const phoneInbox = collect(link.phone);
    const hostInbox = collect(link.host.channel);
    link.host.channel.sendControl({ type: "welcome", hostName: "Mac", windows: [] });
    link.phone.sendRpc(new Uint8Array([1, 2, 3]));
    deliver(link.toPhone, link.phone);
    deliver(link.toHost, link.host.channel);

    expect(phoneInbox.control).toEqual([{ type: "welcome", hostName: "Mac", windows: [] }]);
    expect(hostInbox.rpc).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it("主机公钥与二维码不一致时拒绝发送第 3 条消息（配对码不外泄）", () => {
    expect(() => connect({ expectedHostKey: generateNoiseKeyPair().publicKey })).toThrow(
      "host key mismatch",
    );
  });

  it("超过单帧上限的 RPC 消息分片发送并完整重组", () => {
    const link = connect();
    const inbox = collect(link.host.channel);
    const big = new Uint8Array(MOBILE_REMOTE_MAX_FRAME_PLAINTEXT * 3 + 17);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    link.phone.sendRpc(big);
    expect(link.toHost.length).toBe(4);
    deliver(link.toHost, link.host.channel);
    expect(inbox.rpc).toHaveLength(1);
    expect(inbox.rpc[0]).toEqual(big);
  });

  it("空 RPC 消息也能送达", () => {
    const link = connect();
    const inbox = collect(link.host.channel);
    link.phone.sendRpc(new Uint8Array(0));
    deliver(link.toHost, link.host.channel);
    expect(inbox.rpc).toEqual([new Uint8Array(0)]);
  });

  it("篡改、重放或乱序的帧解密失败", () => {
    const tampered = connect();
    collect(tampered.host.channel);
    tampered.phone.sendRpc(new Uint8Array([9]));
    const frame = tampered.toHost[0]!;
    frame[0] ^= 0xff;
    expect(() => tampered.host.channel.receive(frame)).toThrow(NoiseError);

    const replay = connect();
    collect(replay.host.channel);
    replay.phone.sendRpc(new Uint8Array([1]));
    const first = replay.toHost[0]!;
    replay.host.channel.receive(first);
    expect(() => replay.host.channel.receive(first)).toThrow(NoiseError);

    const reorder = connect();
    collect(reorder.host.channel);
    reorder.phone.sendRpc(new Uint8Array([1]));
    reorder.phone.sendRpc(new Uint8Array([2]));
    expect(() => reorder.host.channel.receive(reorder.toHost[1]!)).toThrow(NoiseError);
  });

  it("中继看到的字节里不含明文 RPC 与配对码", () => {
    const secret = "PAIRING-CODE-SHOULD-NOT-LEAK";
    const link = connect({ pairingCode: secret });
    collect(link.host.channel);
    const marker = new TextEncoder().encode("RPC-PLAINTEXT-MARKER");
    link.phone.sendRpc(marker);
    const all = Buffer.concat([...link.wire, ...link.toHost].map((b) => Buffer.from(b)));
    expect(all.includes(Buffer.from(secret))).toBe(false);
    expect(all.includes(Buffer.from(marker))).toBe(false);
  });

  it("握手前收到的帧在 setHandlers 后按序投递", () => {
    const link = connect();
    link.phone.sendRpc(new Uint8Array([7]));
    deliver(link.toHost, link.host.channel);
    const inbox = collect(link.host.channel);
    expect(inbox.rpc).toEqual([new Uint8Array([7])]);
  });

  it("非法控制消息按协议错误抛出", () => {
    const link = connect();
    collect(link.host.channel);
    link.phone.sendControl({ type: "attach", windowId: 1.5 } as never);
    expect(() => deliver(link.toHost, link.host.channel)).toThrow("invalid control message");
  });
});

describe("mobile remote pairing link", () => {
  it("生成的链接把配对信息放在 hash 中并可解析回来", () => {
    const hostId = bytesToBase64Url(generateNoiseKeyPair().publicKey);
    const url = buildMobileRemotePairingUrl("https://relay.example.com/", {
      hostId,
      hostName: "我的 Mac",
      pairingCode: "K7M29QXD",
    });
    expect(url.startsWith("https://relay.example.com/m/#pair=")).toBe(true);
    expect(parseMobileRemotePairingHash(new URL(url).hash)).toEqual({
      hostId,
      hostName: "我的 Mac",
      pairingCode: "K7M29QXD",
    });
  });

  it("无效 hash 返回 null", () => {
    expect(parseMobileRemotePairingHash("")).toBeNull();
    expect(parseMobileRemotePairingHash("#pair=***")).toBeNull();
    expect(parseMobileRemotePairingHash("#pair=e30")).toBeNull();
  });

  it("中继地址推导 WebSocket 地址", () => {
    expect(relayWebSocketUrl("https://r.example.com", "/v1/connect", { host: "abc" })).toBe(
      "wss://r.example.com/v1/connect?host=abc",
    );
    expect(relayWebSocketUrl("http://127.0.0.1:8787/", "/v1/host", { host: "a", token: "t" })).toBe(
      "ws://127.0.0.1:8787/v1/host?host=a&token=t",
    );
    expect(() => relayWebSocketUrl("ftp://x", "/v1/host", {})).toThrow();
  });
});
