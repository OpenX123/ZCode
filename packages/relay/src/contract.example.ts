/**
 * mobile-remote-relay 标准配置：反向代理提供 HTTPS，中继监听本机端口并托管手机网页。
 */
import type { RelayOptions } from "./contract.js";

export const relayOptionsExample = {
  hostToken: "replace-with-a-long-random-token",
  staticDir: "/opt/zcode-relay/mobile",
} satisfies RelayOptions;
