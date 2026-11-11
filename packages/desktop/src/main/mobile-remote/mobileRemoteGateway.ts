/**
 * 手机远控 Main 网关：中继控制连接 + 每条手机连接的握手、鉴权、窗口接入与转发。
 *
 * 所有权（见 docs/desktop/mobile-remote-spec.md）：
 * - 主机密钥、配置、设备列表、配对码：本网关是唯一所有者，经 MobileRemoteStore 落盘。
 * - 会话、订阅、补发：窗口 Host；网关只把解密后的 RPC 消息原样投递到 attachment 端口，
 *   不缓存、不改写、不排队业务消息。
 */
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  MobileRemoteResponderHandshake,
  buildMobileRemotePairingUrl,
  bytesToBase64Url,
  constantTimeEqual,
  formatMobileRemotePairingCode,
  mobileRemotePairingCodeFromBytes,
  mobileRemotePairingLookupKey,
  normalizeMobileRemotePairingCode,
  normalizeRelayHttpUrl,
  relayWebSocketUrl,
  type MobileRemoteControl,
  type MobileRemoteErrorCode,
  type MobileRemoteRelayHostMessage,
  type MobileRemoteRelayState,
  type MobileRemoteStatus,
  type SecureChannel,
} from "@zcode/shared/mobile-remote";
import type {
  MobileRemoteGateway,
  MobileRemoteGatewayDependencies,
  MobileRemoteHostPort,
} from "./contract.js";
import type { MobileRemoteState } from "./mobileRemoteStore.js";

export const MobileRemoteCloseCodes = {
  unknownDevice: 4403,
  revoked: 4403,
  protocol: 4400,
  windowClosed: 4410,
  handshakeTimeout: 4408,
  disabled: 4000,
} as const;

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** 同一张配对码累计校验失败达到该次数即作废（8 位码可被在线猜测，见 spec「安全」）。 */
const MAX_PAIRING_FAILURES = 5;
/** WebSocket 发送缓冲超过上限时通知 Host 拥塞，降到下限后恢复。 */
const FLOW_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const FLOW_LOW_WATER_BYTES = 512 * 1024;
const FLOW_POLL_MS = 200;

interface ActiveConnection {
  deviceId?: string;
  ws: WebSocket;
  close(code: number, reason: string): void;
}

export function createMobileRemoteGateway(
  deps: MobileRemoteGatewayDependencies,
): MobileRemoteGateway {
  const now = deps.now ?? Date.now;
  const reconnectDelays = deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const pairingTtlMs = deps.pairingTtlMs ?? PAIRING_TTL_MS;
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;

  let state: MobileRemoteState | null = null;
  let relayState: MobileRemoteRelayState = "disabled";
  let lastError: string | undefined;
  let control: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  /** 配置代际：配置变化后旧代际的连接回调一律忽略，避免旧中继连接覆盖新状态。 */
  let generation = 0;
  /** 当前有效配对码（规范化 8 位）；唯一所有者是网关，中继只持有其查询键。 */
  let pairing: { code: string; expiresAt: number; failures: number } | null = null;
  const connections = new Set<ActiveConnection>();
  let disposed = false;

  function requireState(): MobileRemoteState {
    if (!state) throw new Error("mobile remote gateway not started");
    return state;
  }

  function hostId(): string {
    return bytesToBase64Url(requireState().hostKey.publicKey);
  }

  function getStatus(): MobileRemoteStatus {
    const current = requireState();
    const connected = new Set([...connections].map((c) => c.deviceId).filter(Boolean));
    return {
      enabled: current.enabled,
      relayUrl: current.relayUrl,
      hasRelayToken: current.relayToken.length > 0,
      hostId: hostId(),
      hostName: deps.hostName(),
      relay: relayState,
      ...(lastError ? { lastError } : {}),
      devices: current.devices.map((device) => ({
        ...device,
        connected: connected.has(device.id),
      })),
    };
  }

  function emitStatus(): void {
    if (!state || disposed) return;
    deps.onStatusChanged?.(getStatus());
  }

  function setRelayState(next: MobileRemoteRelayState, error?: string): void {
    relayState = next;
    lastError = error;
    emitStatus();
  }

  function sendToRelay(message: MobileRemoteRelayHostMessage): void {
    if (control?.readyState === WebSocket.OPEN) control.send(JSON.stringify(message));
  }

  /** 把当前配对码登记到中继（无有效码时撤销）；中继重连后也调用，保证登记与网关状态一致。 */
  function syncPairingOffer(): void {
    if (pairing && pairing.expiresAt > now()) {
      sendToRelay({
        type: "pairing-offer",
        lookup: mobileRemotePairingLookupKey(pairing.code),
        expiresAt: pairing.expiresAt,
      });
      return;
    }
    pairing = null;
    sendToRelay({ type: "pairing-clear" });
  }

  function invalidatePairing(): void {
    pairing = null;
    syncPairingOffer();
  }

  function stopRelay(): void {
    generation += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    const current = control;
    control = null;
    current?.removeAllListeners();
    current?.on("error", () => {});
    current?.terminate();
    for (const connection of connections) {
      connection.close(MobileRemoteCloseCodes.disabled, "mobile remote disabled");
    }
  }

  function scheduleReconnect(currentGeneration: number): void {
    if (disposed || currentGeneration !== generation) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 30_000;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRelay(currentGeneration);
    }, delay);
  }

  function connectRelay(currentGeneration: number): void {
    const current = requireState();
    if (disposed || currentGeneration !== generation || !current.enabled) return;
    if (!current.relayUrl || !current.relayToken) {
      setRelayState("offline", "中继地址或令牌未配置");
      return;
    }
    let url: string;
    try {
      url = relayWebSocketUrl(current.relayUrl, "/v1/host", {
        host: hostId(),
        token: current.relayToken,
      });
    } catch (error) {
      setRelayState("offline", error instanceof Error ? error.message : String(error));
      return;
    }
    // 重连期间保留上次错误，设置页才能持续显示断开原因。
    setRelayState("connecting", lastError);
    const ws = new WebSocket(url);
    control = ws;
    ws.on("open", () => {
      if (currentGeneration !== generation) return;
      reconnectAttempt = 0;
      setRelayState("online");
      // 中继重启或网络切换后登记会丢失，重新登记仍有效的配对码。
      syncPairingOffer();
      deps.logger.info("[mobile-remote] relay online");
    });
    ws.on("message", (raw) => {
      if (currentGeneration !== generation) return;
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const connId = (message as { type?: string; connId?: unknown }).connId;
      if ((message as { type?: string }).type === "incoming" && typeof connId === "string") {
        acceptConnection(currentGeneration, connId);
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      if (currentGeneration !== generation) return;
      const error =
        res.statusCode === 401 ? "中继令牌错误" : `中继拒绝连接（HTTP ${res.statusCode}）`;
      deps.logger.warn(`[mobile-remote] relay rejected: ${res.statusCode}`);
      control = null;
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      setRelayState("offline", error);
      // 令牌错误属于配置问题，重试只会反复被拒；等用户修改配置后 setConfig 重新连接。
      if (res.statusCode !== 401) scheduleReconnect(currentGeneration);
    });
    ws.on("error", (error) => {
      if (currentGeneration !== generation) return;
      deps.logger.warn("[mobile-remote] relay socket error", error.message);
      lastError = error.message;
    });
    ws.on("close", (code) => {
      if (currentGeneration !== generation || control !== ws) return;
      control = null;
      // 4409 = 同一主机在别处注册（另一台机器复制了密钥），不抢回，避免两端互踢。
      if (code === 4409) {
        setRelayState("offline", "同一主机身份已在其他位置连接中继");
        return;
      }
      if (relayState !== "offline") setRelayState("offline", lastError);
      scheduleReconnect(currentGeneration);
    });
  }

  function acceptConnection(currentGeneration: number, connId: string): void {
    if (currentGeneration !== generation) return;
    const current = requireState();
    const url = relayWebSocketUrl(current.relayUrl, "/v1/accept", {
      host: hostId(),
      conn: connId,
      token: current.relayToken,
    });
    const ws = new WebSocket(url);
    ws.binaryType = "nodebuffer";
    let channel: SecureChannel | null = null;
    let handshake: MobileRemoteResponderHandshake | null = new MobileRemoteResponderHandshake({
      staticKey: current.hostKey,
      write: (data) => send(data),
    });
    let step: "message1" | "message3" | "await-attach" | "attached" = "message1";
    let port: MobileRemoteHostPort | null = null;
    let saturated = false;
    let flowTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const connection: ActiveConnection = {
      ws,
      close(code, reason) {
        if (closed) return;
        closed = true;
        connections.delete(connection);
        clearTimeout(handshakeTimer);
        if (flowTimer) clearInterval(flowTimer);
        port?.close();
        port = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason);
        }
        if (connection.deviceId) emitStatus();
      },
    };
    connections.add(connection);

    const handshakeTimer = setTimeout(() => {
      if (step === "message1" || step === "message3") {
        connection.close(MobileRemoteCloseCodes.handshakeTimeout, "handshake timeout");
      }
    }, handshakeTimeoutMs);

    function send(data: Uint8Array): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(data, { binary: true });
      if (port && !saturated && ws.bufferedAmount > FLOW_HIGH_WATER_BYTES) {
        saturated = true;
        port.postFlowState("saturated");
        flowTimer = setInterval(() => {
          if (ws.bufferedAmount <= FLOW_LOW_WATER_BYTES) {
            saturated = false;
            if (flowTimer) clearInterval(flowTimer);
            flowTimer = null;
            port?.postFlowState("drained");
          }
        }, FLOW_POLL_MS);
      }
    }

    function fail(code: MobileRemoteErrorCode, message: string, closeCode: number): void {
      try {
        channel?.sendControl({ type: "error", code, message });
      } catch {
        // 通道已坏时直接关闭。
      }
      connection.close(closeCode, code);
    }

    function handleControl(message: MobileRemoteControl): void {
      if (message.type === "ping") {
        channel?.sendControl({ type: "pong", ts: message.ts });
        return;
      }
      if (message.type === "pong") return;
      if (message.type !== "attach" || step !== "await-attach") {
        fail("protocol", "unexpected control message", MobileRemoteCloseCodes.protocol);
        return;
      }
      const attached = deps.attachWindow(message.windowId);
      if (!attached) {
        fail("window_unavailable", "窗口不可用", MobileRemoteCloseCodes.windowClosed);
        return;
      }
      port = attached;
      step = "attached";
      // 先挂好 Host → 手机转发，再告诉手机已接入（spec 顺序约束 2）。
      attached.onRpc((rpc) => channel?.sendRpc(rpc));
      attached.onClose(() => {
        port = null;
        fail("window_unavailable", "窗口已关闭", MobileRemoteCloseCodes.windowClosed);
      });
      channel?.sendControl({ type: "attached", windowId: message.windowId });
      deps.logger.info(`[mobile-remote] device attached window ${message.windowId}`);
    }

    async function authorize(
      deviceKey: Uint8Array,
      deviceName: string,
      code?: string,
    ): Promise<boolean> {
      const current = requireState();
      const deviceId = bytesToBase64Url(deviceKey);
      const known = current.devices.find((device) => device.id === deviceId);
      if (known) {
        known.lastSeenAt = now();
        connection.deviceId = deviceId;
        await deps.store.save(current);
        return true;
      }
      if (!code || !pairing) return false;
      if (pairing.expiresAt < now()) {
        invalidatePairing();
        return false;
      }
      const encoder = new TextEncoder();
      const provided = normalizeMobileRemotePairingCode(code) ?? "";
      if (!constantTimeEqual(encoder.encode(provided), encoder.encode(pairing.code))) {
        pairing.failures += 1;
        if (pairing.failures >= MAX_PAIRING_FAILURES) {
          deps.logger.warn("[mobile-remote] pairing code invalidated after repeated failures");
          invalidatePairing();
        }
        return false;
      }
      // 配对码一次性：成功即作废，并撤销中继登记。
      invalidatePairing();
      current.devices.push({ id: deviceId, name: deviceName, pairedAt: now(), lastSeenAt: now() });
      connection.deviceId = deviceId;
      await deps.store.save(current);
      deps.logger.info("[mobile-remote] new device paired");
      return true;
    }

    ws.on("message", (raw: Buffer) => {
      if (closed) return;
      const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      try {
        if (step === "message1") {
          send(handshake!.respond(data));
          step = "message3";
          return;
        }
        if (step === "message3") {
          const result = handshake!.finish(data);
          handshake = null;
          channel = result.channel;
          step = "await-attach";
          clearTimeout(handshakeTimer);
          const established = result.channel;
          void authorize(result.deviceKey, result.hello.deviceName, result.hello.pairingCode).then(
            (ok) => {
              if (closed) return;
              if (!ok) {
                fail(
                  "unknown_device",
                  "设备未配对或配对码已失效",
                  MobileRemoteCloseCodes.unknownDevice,
                );
                return;
              }
              established.setHandlers({
                onRpc: (rpc) => {
                  if (step !== "attached" || !port) {
                    // attach 之前不允许 RPC（spec 顺序约束 1）。
                    fail("protocol", "rpc before attach", MobileRemoteCloseCodes.protocol);
                    return;
                  }
                  port.postRpc(rpc);
                },
                onControl: handleControl,
              });
              established.sendControl({
                type: "welcome",
                hostName: deps.hostName(),
                windows: deps.listWindows(),
              });
              emitStatus();
            },
            (error: unknown) => {
              deps.logger.warn("[mobile-remote] authorize failed", error);
              connection.close(MobileRemoteCloseCodes.protocol, "authorize failed");
            },
          );
          return;
        }
        channel?.receive(data);
      } catch (error) {
        deps.logger.warn(
          "[mobile-remote] connection protocol error",
          error instanceof Error ? error.message : String(error),
        );
        connection.close(MobileRemoteCloseCodes.protocol, "protocol error");
      }
    });
    ws.on("error", (error) => {
      deps.logger.warn("[mobile-remote] connection socket error", error.message);
    });
    ws.on("close", () => connection.close(1000, "closed"));
  }

  function restartRelay(): void {
    stopRelay();
    const current = requireState();
    if (!current.enabled) {
      setRelayState("disabled");
      return;
    }
    connectRelay(generation);
  }

  return {
    async start() {
      state = await deps.store.load();
      restartRelay();
    },
    getStatus,
    async setConfig(input) {
      const current = requireState();
      const relayUrl = input.relayUrl.trim() ? normalizeRelayHttpUrl(input.relayUrl) : "";
      current.enabled = input.enabled;
      current.relayUrl = relayUrl;
      if (input.relayToken !== undefined) current.relayToken = input.relayToken.trim();
      // 关闭手机远控或更换中继后旧配对码失效（中继登记随控制连接断开清除）。
      pairing = null;
      await deps.store.save(current);
      restartRelay();
      return getStatus();
    },
    createPairing() {
      const current = requireState();
      if (!current.enabled || !current.relayUrl) {
        throw new Error("请先开启手机远控并配置中继地址");
      }
      // 重新生成会作废上一张配对码（中继登记同时被新码覆盖）。
      const code = mobileRemotePairingCodeFromBytes(new Uint8Array(randomBytes(8)));
      const expiresAt = now() + pairingTtlMs;
      pairing = { code, expiresAt, failures: 0 };
      syncPairingOffer();
      return {
        url: buildMobileRemotePairingUrl(current.relayUrl, {
          hostId: hostId(),
          hostName: deps.hostName(),
          pairingCode: code,
        }),
        code: formatMobileRemotePairingCode(code),
        expiresAt,
      };
    },
    async revokeDevice(deviceId) {
      const current = requireState();
      current.devices = current.devices.filter((device) => device.id !== deviceId);
      await deps.store.save(current);
      for (const connection of connections) {
        if (connection.deviceId === deviceId) {
          connection.close(MobileRemoteCloseCodes.revoked, "revoked");
        }
      }
      emitStatus();
      return getStatus();
    },
    dispose() {
      disposed = true;
      stopRelay();
    },
  };
}
