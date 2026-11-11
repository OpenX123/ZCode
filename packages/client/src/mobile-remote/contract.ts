/**
 * mobile-remote-client 对外契约：手机网页经自托管中继连接桌面窗口 Host。
 * connectMobileRemote 在收到 attached 后 resolve；之后断线只通过 onClose 通知，不自动重连
 * （重连策略属于手机外壳）。
 */
import type { ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { MobileRemoteWindow, NoiseKeyPair } from "@zcode/shared/mobile-remote";

export type MobileRemoteConnectErrorCode =
  | "host_offline"
  | "unknown_device"
  | "revoked"
  | "host_key_mismatch"
  | "window_unavailable"
  | "no_window"
  | "timeout"
  | "protocol"
  | "network"
  | "pairing_not_found"
  | "rate_limited";

export class MobileRemoteConnectError extends Error {
  constructor(
    readonly code: MobileRemoteConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MobileRemoteConnectError";
  }
}

export interface MobileRemoteCloseInfo {
  code: number;
  reason: string;
  /** 主机侧通过控制消息告知的错误（如设备被移除、窗口关闭） */
  error?: MobileRemoteConnectErrorCode;
}

export interface MobileRemoteLink<T> {
  /** bindProtocol 的返回值（通常是 ChannelClient） */
  bound: T;
  hostName: string;
  windowId: number;
  windows: MobileRemoteWindow[];
  onClose(handler: (info: MobileRemoteCloseInfo) => void): () => void;
  close(): void;
}

export interface MobileRemoteSession extends Omit<MobileRemoteLink<ChannelClient>, "bound"> {
  services: IServiceAccessor;
}

export interface MobileRemoteConnectOptions {
  relayUrl: string;
  hostId: string;
  deviceKey: NoiseKeyPair;
  deviceName: string;
  pairingCode?: string;
  /** 收到窗口列表后选择接入的窗口；返回 null 表示放弃连接 */
  chooseWindow: (windows: MobileRemoteWindow[]) => number | null | Promise<number | null>;
  timeoutMs?: number;
  pingIntervalMs?: number;
  /** 测试或非浏览器环境注入 */
  WebSocketImpl?: typeof WebSocket;
}
