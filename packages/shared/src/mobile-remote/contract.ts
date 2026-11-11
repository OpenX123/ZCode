/**
 * mobile-remote-link 对外契约：桌面设置页与 Main 网关之间的手机远控状态（IPC 载荷）。
 * 握手、分帧与控制消息的运行时 API 由 index.ts 导出，语义见 CONTRACT.md。
 */

export type MobileRemoteRelayState = "disabled" | "connecting" | "online" | "offline";

export interface MobileRemoteDeviceInfo {
  /** 设备公钥 base64url */
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt?: number;
  connected: boolean;
}

export interface MobileRemoteStatus {
  enabled: boolean;
  relayUrl: string;
  hasRelayToken: boolean;
  hostId: string;
  hostName: string;
  relay: MobileRemoteRelayState;
  lastError?: string;
  devices: MobileRemoteDeviceInfo[];
}

export interface MobileRemoteConfigInput {
  enabled: boolean;
  relayUrl: string;
  /** 不传表示保留已保存的令牌 */
  relayToken?: string;
}

export interface MobileRemotePairingTicket {
  /** 二维码内容（配对链接） */
  url: string;
  /** 手输用配对码，展示格式 `XXXX-XXXX` */
  code: string;
  expiresAt: number;
}

/**
 * 主机控制连接上发给中继的配对登记消息（spec「中继」）。
 * lookup = mobileRemotePairingLookupKey(配对码)，中继不接触明文配对码。
 */
export type MobileRemoteRelayHostMessage =
  | { type: "pairing-offer"; lookup: string; expiresAt: number }
  | { type: "pairing-clear" };

/** 中继 `GET /v1/pair/<lookup>` 命中时的响应体。 */
export interface MobileRemotePairingLookupResult {
  hostId: string;
}
