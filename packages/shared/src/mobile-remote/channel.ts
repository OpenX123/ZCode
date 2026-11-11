/**
 * 手机远控加密通道：握手编排 + 握手后的分帧。与具体 socket 无关，
 * 浏览器（手机）与 Electron Main（网关）都通过「收到字节 → receive」「send 回调 → 发字节」接入。
 *
 * 帧格式（加密前明文）：第 1 字节为类型，其余为内容。
 *   0 = RPC 消息最后一片（或完整消息）
 *   1 = RPC 消息分片，后面还有
 *   2 = 控制 JSON
 * 每个 WebSocket 二进制消息恰好是一个 Noise 传输消息；nonce 隐式递增，
 * 任何解密失败、乱序或重放都会抛出 NoiseError，调用方必须断开连接。
 */
import {
  MOBILE_REMOTE_PROLOGUE,
  decodeJson,
  encodeJson,
  mobileRemoteControlSchema,
  mobileRemoteHelloSchema,
  type MobileRemoteControl,
  type MobileRemoteHello,
} from "./control.js";
import {
  NoiseError,
  NoiseXXHandshake,
  constantTimeEqual,
  type NoiseKeyPair,
  type NoiseTransport,
} from "./noise.js";

const FRAME_RPC_FINAL = 0;
const FRAME_RPC_MORE = 1;
const FRAME_CONTROL = 2;
/** 单帧明文上限；加上 16 字节 tag 仍低于 Noise 的 65535 上限。 */
export const MOBILE_REMOTE_MAX_FRAME_PLAINTEXT = 65_000;
/** 重组后的单条 RPC 消息上限，防止对端用无尽分片耗尽内存。 */
export const MOBILE_REMOTE_MAX_RPC_MESSAGE = 64 * 1024 * 1024;

export interface SecureChannelHandlers {
  onRpc(message: Uint8Array): void;
  onControl(message: MobileRemoteControl): void;
}

export class SecureChannel {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private handlers: SecureChannelHandlers | null = null;
  private buffered: Uint8Array[] = [];

  constructor(
    private readonly transport: NoiseTransport,
    private readonly write: (data: Uint8Array) => void,
  ) {}

  get remoteStaticKey(): Uint8Array {
    return this.transport.remoteStaticKey;
  }

  /** 设置处理器；设置前收到的帧先缓存，避免握手后到 handler 挂上之间丢帧。 */
  setHandlers(handlers: SecureChannelHandlers): void {
    this.handlers = handlers;
    const buffered = this.buffered;
    this.buffered = [];
    for (const data of buffered) this.receive(data);
  }

  sendRpc(message: Uint8Array): void {
    let offset = 0;
    const chunk = MOBILE_REMOTE_MAX_FRAME_PLAINTEXT - 1;
    do {
      const end = Math.min(offset + chunk, message.length);
      const last = end >= message.length;
      this.writeFrame(last ? FRAME_RPC_FINAL : FRAME_RPC_MORE, message.subarray(offset, end));
      offset = end;
    } while (offset < message.length);
  }

  sendControl(message: MobileRemoteControl): void {
    this.writeFrame(FRAME_CONTROL, encodeJson(message));
  }

  /** 收到一条 WebSocket 二进制消息。解密或格式错误时抛错，调用方负责断开。 */
  receive(data: Uint8Array): void {
    if (!this.handlers) {
      this.buffered.push(data);
      return;
    }
    const plaintext = this.transport.receive.decryptWithAd(new Uint8Array(0), data);
    if (plaintext.length === 0) throw new NoiseError("empty frame");
    const type = plaintext[0];
    const body = plaintext.subarray(1);
    if (type === FRAME_CONTROL) {
      const parsed = mobileRemoteControlSchema.safeParse(decodeJson(body));
      if (!parsed.success) throw new NoiseError("invalid control message");
      this.handlers.onControl(parsed.data);
      return;
    }
    if (type !== FRAME_RPC_FINAL && type !== FRAME_RPC_MORE) {
      throw new NoiseError(`unknown frame type ${String(type)}`);
    }
    this.pendingBytes += body.length;
    if (this.pendingBytes > MOBILE_REMOTE_MAX_RPC_MESSAGE) throw new NoiseError("rpc message too large");
    if (type === FRAME_RPC_MORE) {
      this.pending.push(body.slice());
      return;
    }
    let message: Uint8Array;
    if (this.pending.length === 0) {
      message = body.slice();
    } else {
      message = new Uint8Array(this.pendingBytes);
      let offset = 0;
      for (const part of this.pending) {
        message.set(part, offset);
        offset += part.length;
      }
      message.set(body, offset);
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.handlers.onRpc(message);
  }

  private writeFrame(type: number, body: Uint8Array): void {
    const plaintext = new Uint8Array(body.length + 1);
    plaintext[0] = type;
    plaintext.set(body, 1);
    this.write(this.transport.send.encryptWithAd(new Uint8Array(0), plaintext));
  }
}

/**
 * 手机端（initiator）握手。用法：
 *   const hs = new MobileRemoteInitiatorHandshake({...}); send(hs.start());
 *   收到第 2 条 → const { message, channel } = hs.finish(msg2); send(message);
 */
export class MobileRemoteInitiatorHandshake {
  private readonly noise: NoiseXXHandshake;

  constructor(
    private readonly options: {
      staticKey: NoiseKeyPair;
      /** 二维码或已配对记录中的主机公钥；握手得到的主机公钥必须与之一致 */
      expectedHostKey: Uint8Array;
      hello: MobileRemoteHello;
      write: (data: Uint8Array) => void;
    },
  ) {
    this.noise = new NoiseXXHandshake("initiator", options.staticKey, MOBILE_REMOTE_PROLOGUE);
  }

  start(): Uint8Array {
    return this.noise.writeMessage1();
  }

  finish(message2: Uint8Array): { message: Uint8Array; channel: SecureChannel } {
    this.noise.readMessage2(message2);
    const hostKey = this.noise.remoteStaticKey;
    // 先校验主机身份再发第 3 条：配对码只会加密发给真正持有主机私钥的一方。
    if (!hostKey || !constantTimeEqual(hostKey, this.options.expectedHostKey)) {
      throw new NoiseError("host key mismatch");
    }
    const { message, transport } = this.noise.writeMessage3(encodeJson(this.options.hello));
    return { message, channel: new SecureChannel(transport, this.options.write) };
  }
}

/** 桌面网关（responder）握手。 */
export class MobileRemoteResponderHandshake {
  private readonly noise: NoiseXXHandshake;

  constructor(
    private readonly options: { staticKey: NoiseKeyPair; write: (data: Uint8Array) => void },
  ) {
    this.noise = new NoiseXXHandshake("responder", options.staticKey, MOBILE_REMOTE_PROLOGUE);
  }

  respond(message1: Uint8Array): Uint8Array {
    this.noise.readMessage1(message1);
    return this.noise.writeMessage2();
  }

  /** 返回已认证的设备公钥与 hello；是否放行由调用方按设备登记与配对码决定。 */
  finish(message3: Uint8Array): {
    hello: MobileRemoteHello;
    deviceKey: Uint8Array;
    channel: SecureChannel;
  } {
    const { payload, transport } = this.noise.readMessage3(message3);
    let json: unknown;
    try {
      json = decodeJson(payload);
    } catch {
      throw new NoiseError("invalid hello");
    }
    const parsed = mobileRemoteHelloSchema.safeParse(json);
    if (!parsed.success) throw new NoiseError("invalid hello");
    return {
      hello: parsed.data,
      deviceKey: transport.remoteStaticKey,
      channel: new SecureChannel(transport, this.options.write),
    };
  }
}
