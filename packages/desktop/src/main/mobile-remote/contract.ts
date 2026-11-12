/**
 * mobile-remote-gateway 对外契约：Electron Main 中的手机远控网关。
 * 网关是主机密钥、中继配置、已配对设备与一次性配对码的唯一所有者；
 * 会话状态归窗口 Host，网关只把解密后的 RPC 原样转发到 attachment 端口。
 */
import type {
  MobileRemoteConfigInput,
  MobileRemotePairingTicket,
  MobileRemoteStatus,
  MobileRemoteWindow,
} from "@zcode/shared/mobile-remote";
import type { MobileRemoteStore } from "./mobileRemoteStore.js";

/** 窗口 Host attachment 端口的最小抽象，由 index.ts 用 MessagePortMain 实现。 */
export interface MobileRemoteHostPort {
  postRpc(message: Uint8Array): void;
  postFlowState(state: "saturated" | "drained"): void;
  onRpc(handler: (message: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface MobileRemoteGatewayDependencies {
  store: MobileRemoteStore;
  hostName: () => string;
  listWindows: () => MobileRemoteWindow[];
  attachWindow: (windowId: number) => MobileRemoteHostPort | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  onStatusChanged?: (status: MobileRemoteStatus) => void;
  /** 测试注入：缩短重连、配对码有效期 */
  now?: () => number;
  reconnectDelaysMs?: readonly number[];
  pairingTtlMs?: number;
  handshakeTimeoutMs?: number;
}

export interface MobileRemoteGateway {
  start(): Promise<void>;
  getStatus(): MobileRemoteStatus;
  setConfig(input: MobileRemoteConfigInput): Promise<MobileRemoteStatus>;
  createPairing(): MobileRemotePairingTicket;
  revokeDevice(deviceId: string): Promise<MobileRemoteStatus>;
  dispose(): void;
}
