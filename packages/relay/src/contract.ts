/**
 * mobile-remote-relay 对外契约：自托管中继的配置与关闭码。
 * 中继只把手机连接与主机连接逐字节对接，并托管 /m/ 手机网页；不解析、不记录内容。
 */

export interface RelayLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface RelayOptions {
  /** 主机注册与 accept 所需令牌；为空则拒绝所有主机（防止误部署成开放中继）。 */
  hostToken: string;
  /** 手机网页构建产物目录；不传则不托管静态文件。 */
  staticDir?: string;
  logger?: RelayLogger;
  /** 以下限额默认值见 spec，测试可调小。 */
  acceptTimeoutMs?: number;
  maxConnectionsPerHost?: number;
  maxMessageBytes?: number;
  pingIntervalMs?: number;
  /** accept 前手机已发出的字节缓存上限（握手第 1 条消息） */
  maxPendingBytes?: number;
  /** 部署在自己的反向代理之后时开启：配对码查询限流按 X-Forwarded-For 最后一跳计客户端。 */
  trustProxy?: boolean;
  /** 同一客户端每分钟允许的配对码查询未命中次数 */
  pairingMissesPerMinute?: number;
  /** 配对登记最长有效期 */
  maxPairingTtlMs?: number;
}

export const RelayCloseCodes = {
  hostReplaced: 4409,
  hostOffline: 4404,
  acceptTimeout: 4408,
  tooManyConnections: 4429,
  unauthorized: 4401,
  badRequest: 4400,
  peerClosed: 4000,
} as const;
