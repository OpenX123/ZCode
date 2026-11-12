/**
 * 手机端连接：中继 WebSocket → Noise XX 握手 → welcome → 选择窗口 → attach，
 * 之后把加密通道包装成 IMessagePassingProtocol，交给 ChannelClient / RemoteServiceAccess。
 * 时序约束见 docs/desktop/mobile-remote-spec.md「连接拓扑与事件顺序」。
 */
import { ChannelClient, Emitter, VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import {
  MobileRemoteInitiatorHandshake,
  base64UrlToBytes,
  relayWebSocketUrl,
  type MobileRemoteControl,
  type SecureChannel,
} from "@zcode/shared/mobile-remote";
import { RemoteServiceAccess } from "../remoteServiceAccess.js";
import {
  MobileRemoteConnectError,
  type MobileRemoteCloseInfo,
  type MobileRemoteConnectErrorCode,
  type MobileRemoteConnectOptions,
  type MobileRemoteLink,
  type MobileRemoteSession,
} from "./contract.js";

const RELAY_CLOSE_HOST_OFFLINE = 4404;
const HOST_CLOSE_UNKNOWN_DEVICE = 4403;
const HOST_CLOSE_WINDOW_CLOSED = 4410;

function errorFromControl(code: string): MobileRemoteConnectErrorCode {
  switch (code) {
    case "unknown_device":
      return "unknown_device";
    case "revoked":
      return "revoked";
    case "window_unavailable":
      return "window_unavailable";
    default:
      return "protocol";
  }
}

function errorFromCloseCode(code: number): MobileRemoteConnectErrorCode {
  if (code === RELAY_CLOSE_HOST_OFFLINE) return "host_offline";
  if (code === HOST_CLOSE_UNKNOWN_DEVICE) return "unknown_device";
  if (code === HOST_CLOSE_WINDOW_CLOSED) return "window_unavailable";
  return "network";
}

/** 把握手后的加密通道适配为 RPC 协议：一条 RPC 消息 = 一次 sendRpc。 */
class SecureChannelProtocol implements IMessagePassingProtocol {
  private readonly emitter = new Emitter<VSBuffer>();
  readonly onMessage = this.emitter.event;

  constructor(private readonly channel: SecureChannel) {}

  send(buffer: VSBuffer): void {
    this.channel.sendRpc(buffer.buffer);
  }

  deliver(message: Uint8Array): void {
    this.emitter.fire(VSBuffer.wrap(message));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** 手机网页入口：建立加密链路后组装成与 Web/桌面相同的 RemoteServiceAccess。 */
export async function connectMobileRemote(
  options: MobileRemoteConnectOptions,
): Promise<MobileRemoteSession> {
  const { bound: client, ...link } = await connectMobileRemoteLink(options, (protocol) => {
    return new ChannelClient(protocol);
  });
  return { ...link, services: new RemoteServiceAccess(client, {}) };
}

/**
 * 底层链路。bindProtocol 在发送 attach 之前同步调用，调用方必须在其中挂好消息监听
 * （例如创建 ChannelClient），否则会错过 Host 的 Initialize。链路关闭时若返回值有 dispose 会被调用。
 */
export function connectMobileRemoteLink<T extends { dispose(reason?: Error): void }>(
  options: MobileRemoteConnectOptions,
  bindProtocol: (protocol: IMessagePassingProtocol) => T,
): Promise<MobileRemoteLink<T>> {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const expectedHostKey = base64UrlToBytes(options.hostId);

  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(relayWebSocketUrl(options.relayUrl, "/v1/connect", { host: options.hostId }));
    ws.binaryType = "arraybuffer";
    let settled = false;
    let channel: SecureChannel | null = null;
    let protocol: SecureChannelProtocol | null = null;
    let client: T | null = null;
    let hostError: MobileRemoteConnectErrorCode | undefined;
    let welcome: Extract<MobileRemoteControl, { type: "welcome" }> | null = null;
    let windowId: number | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let lastPongAt = Date.now();
    const closeHandlers = new Set<(info: MobileRemoteCloseInfo) => void>();

    const timeout = setTimeout(() => {
      failBeforeReady(new MobileRemoteConnectError("timeout", "连接超时"));
    }, timeoutMs);

    function failBeforeReady(error: MobileRemoteConnectError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // 忽略
      }
      reject(error);
    }

    const handshake = new MobileRemoteInitiatorHandshake({
      staticKey: options.deviceKey,
      expectedHostKey,
      hello: {
        type: "hello",
        protocolVersion: 1,
        deviceName: options.deviceName,
        ...(options.pairingCode ? { pairingCode: options.pairingCode } : {}),
      },
      write: (data) => {
        if (ws.readyState === WebSocketImpl.OPEN) ws.send(data as Uint8Array<ArrayBuffer>);
      },
    });

    function handleControl(message: MobileRemoteControl): void {
      if (message.type === "pong") {
        lastPongAt = Date.now();
        return;
      }
      if (message.type === "ping") {
        channel?.sendControl({ type: "pong", ts: message.ts });
        return;
      }
      if (message.type === "error") {
        hostError = errorFromControl(message.code);
        failBeforeReady(new MobileRemoteConnectError(hostError, message.message));
        return;
      }
      if (message.type === "welcome" && !welcome) {
        welcome = message;
        void Promise.resolve(options.chooseWindow(message.windows)).then(
          (chosen) => {
            if (settled) return;
            if (chosen === null) {
              failBeforeReady(new MobileRemoteConnectError("no_window", "没有可接入的窗口"));
              return;
            }
            windowId = chosen;
            // 先建好 RPC 接收端再发 attach，保证不丢 Host 的 Initialize（spec 顺序约束 2）。
            protocol = new SecureChannelProtocol(channel!);
            client = bindProtocol(protocol);
            channel!.sendControl({ type: "attach", windowId: chosen });
          },
          (error: unknown) =>
            failBeforeReady(new MobileRemoteConnectError("protocol", String(error))),
        );
        return;
      }
      if (message.type === "attached" && welcome && client && windowId === message.windowId) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        startPing();
        resolve({
          bound: client,
          hostName: welcome.hostName,
          windowId,
          windows: welcome.windows,
          onClose(handler) {
            closeHandlers.add(handler);
            return () => closeHandlers.delete(handler);
          },
          close() {
            ws.close(1000, "client closed");
          },
        });
      }
    }

    function startPing(): void {
      lastPongAt = Date.now();
      pingTimer = setInterval(() => {
        // 手机切后台或换网络时 TCP 可能半开：两个周期没有 pong 就主动断开，触发重连。
        if (Date.now() - lastPongAt > pingIntervalMs * 2) {
          ws.close(4000, "ping timeout");
          return;
        }
        try {
          channel?.sendControl({ type: "ping", ts: Date.now() });
        } catch {
          ws.close(4000, "ping failed");
        }
      }, pingIntervalMs);
    }

    let step: "message2" | "established" = "message2";
    ws.addEventListener("open", () => {
      ws.send(handshake.start() as Uint8Array<ArrayBuffer>);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      try {
        if (step === "message2") {
          const result = handshake.finish(data);
          ws.send(result.message as Uint8Array<ArrayBuffer>);
          channel = result.channel;
          channel.setHandlers({
            onRpc: (message) => protocol?.deliver(message),
            onControl: handleControl,
          });
          step = "established";
          return;
        }
        channel?.receive(data);
      } catch (error) {
        const mismatch = error instanceof Error && error.message === "host key mismatch";
        failBeforeReady(
          new MobileRemoteConnectError(
            mismatch ? "host_key_mismatch" : "protocol",
            mismatch ? "主机身份校验失败" : "加密通道错误",
          ),
        );
        ws.close(4400, "protocol error");
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timeout);
      if (pingTimer) clearInterval(pingTimer);
      const error = hostError ?? errorFromCloseCode(event.code);
      if (!settled) {
        settled = true;
        reject(new MobileRemoteConnectError(error, event.reason || "连接已断开"));
        return;
      }
      client?.dispose(new Error("mobile remote connection closed"));
      protocol?.dispose();
      for (const handler of closeHandlers) {
        handler({ code: event.code, reason: event.reason, ...(error !== "network" ? { error } : {}) });
      }
    });
    ws.addEventListener("error", () => {
      // close 事件随后到达，统一在 close 中处理。
    });
  });
}
