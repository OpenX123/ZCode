/**
 * 手机远控加密通道内的控制消息。字段与 docs/desktop/mobile-remote-spec.md「控制消息」一节一致，
 * 收到的每条控制消息都经 zod 运行时校验，校验失败按协议错误断开。
 */
import { z } from "zod";

export const MOBILE_REMOTE_PROTOCOL_VERSION = 1;
/** Noise prologue：绑定协议用途与版本，防止握手被挪用到其他协议。 */
export const MOBILE_REMOTE_PROLOGUE = new TextEncoder().encode("zcode-mobile-remote/v1");

export const mobileRemoteHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(MOBILE_REMOTE_PROTOCOL_VERSION),
  deviceName: z.string().trim().min(1).max(80),
  pairingCode: z.string().min(1).max(64).optional(),
});

export const mobileRemoteWindowSchema = z.object({
  windowId: z.number().int(),
  title: z.string().max(200),
  focused: z.boolean(),
  /** 窗口当前的本地工作区路径，手机端据此打开同一工作区 */
  workspacePath: z.string().max(4096).optional(),
});

export const mobileRemoteErrorCodeSchema = z.enum([
  "unknown_device",
  "window_unavailable",
  "protocol",
  "revoked",
]);

export const mobileRemoteControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    hostName: z.string().max(120),
    windows: z.array(mobileRemoteWindowSchema).max(64),
  }),
  z.object({ type: z.literal("attach"), windowId: z.number().int() }),
  z.object({ type: z.literal("attached"), windowId: z.number().int() }),
  z.object({
    type: z.literal("error"),
    code: mobileRemoteErrorCodeSchema,
    message: z.string().max(500),
  }),
  z.object({ type: z.literal("ping"), ts: z.number() }),
  z.object({ type: z.literal("pong"), ts: z.number() }),
]);

export type MobileRemoteHello = z.infer<typeof mobileRemoteHelloSchema>;
export type MobileRemoteWindow = z.infer<typeof mobileRemoteWindowSchema>;
export type MobileRemoteErrorCode = z.infer<typeof mobileRemoteErrorCodeSchema>;
export type MobileRemoteControl = z.infer<typeof mobileRemoteControlSchema>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}
