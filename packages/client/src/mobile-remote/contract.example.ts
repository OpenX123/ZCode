/**
 * mobile-remote-client 标准调用：扫码后带配对码连接，单窗口自动接入。
 */
import type { MobileRemoteConnectOptions } from "./contract.js";

export const mobileRemoteConnectExample = {
  relayUrl: "https://relay.example.com",
  hostId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  deviceKey: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
  deviceName: "iPhone",
  pairingCode: "one-time-code-from-qr",
  chooseWindow: (windows) => windows.find((w) => w.focused)?.windowId ?? windows[0]?.windowId ?? null,
} satisfies MobileRemoteConnectOptions;
