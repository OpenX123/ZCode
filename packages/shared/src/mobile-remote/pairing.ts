/**
 * 配对链接：`<中继地址>/m/#pair=<base64url(JSON)>`。
 * 放在 hash 里，浏览器不会把它发给中继服务器；手机网页读取后立即清掉。
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";

/** Crockford Base32：去掉易混淆的 I L O U。 */
export const MOBILE_REMOTE_PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MOBILE_REMOTE_PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const LOOKUP_PREFIX = new TextEncoder().encode("zcode-mobile-remote/pair-lookup/v1:");

const pairingPayloadSchema = z.object({
  v: z.literal(1),
  /** 主机公钥 base64url（即 hostId） */
  h: z.string().min(40).max(64),
  /** 主机显示名 */
  n: z.string().max(120),
  /** 一次性配对码（规范化后的 8 位） */
  c: z.string().regex(PAIRING_CODE_PATTERN),
});

export interface MobileRemotePairingPayload {
  hostId: string;
  hostName: string;
  pairingCode: string;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 规范化用户输入的配对码：忽略大小写、空格与 `-`，O→0、I/L→1。
 * 不是合法的 8 位码时返回 null。
 */
export function normalizeMobileRemotePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return PAIRING_CODE_PATTERN.test(code) ? code : null;
}

/** 展示格式：`XXXX-XXXX`。 */
export function formatMobileRemotePairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** 由随机字节生成配对码（每字节取低 5 位，32 整除 256，分布均匀）。 */
export function mobileRemotePairingCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < MOBILE_REMOTE_PAIRING_CODE_LENGTH) throw new Error("not enough random bytes");
  let code = "";
  for (let i = 0; i < MOBILE_REMOTE_PAIRING_CODE_LENGTH; i += 1) {
    code += MOBILE_REMOTE_PAIRING_ALPHABET[bytes[i]! & 31];
  }
  return code;
}

/** 中继查询键：中继只见到哈希，不接触明文配对码（spec「配对码查询」）。 */
export function mobileRemotePairingLookupKey(code: string): string {
  const normalized = normalizeMobileRemotePairingCode(code);
  if (!normalized) throw new Error("invalid pairing code");
  const body = new TextEncoder().encode(normalized);
  const input = new Uint8Array(LOOKUP_PREFIX.length + body.length);
  input.set(LOOKUP_PREFIX);
  input.set(body, LOOKUP_PREFIX.length);
  return bytesToBase64Url(sha256(input));
}

export type MobileRemotePairingInput =
  | { kind: "link"; relayOrigin: string; payload: MobileRemotePairingPayload }
  | { kind: "code"; code: string };

/**
 * 手机网页的统一配对输入：扫码结果、粘贴的配对链接或手输配对码。
 * 无法识别时返回 null。
 */
export function parseMobileRemotePairingInput(input: string): MobileRemotePairingInput | null {
  const text = input.trim();
  const code = normalizeMobileRemotePairingCode(text);
  if (code) return { kind: "code", code };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const payload = parseMobileRemotePairingHash(url.hash);
  return payload ? { kind: "link", relayOrigin: url.origin, payload } : null;
}

/** relayUrl 为中继根地址（http/https），生成手机扫码打开的网页地址。 */
export function buildMobileRemotePairingUrl(
  relayUrl: string,
  payload: MobileRemotePairingPayload,
): string {
  const base = normalizeRelayHttpUrl(relayUrl);
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ v: 1, h: payload.hostId, n: payload.hostName, c: payload.pairingCode }),
    ),
  );
  return `${base}/m/#pair=${encoded}`;
}

/** 解析 location.hash（可带或不带 `#`），格式不对返回 null。 */
export function parseMobileRemotePairingHash(hash: string): MobileRemotePairingPayload | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const value = new URLSearchParams(raw).get("pair");
  if (!value) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    const parsed = pairingPayloadSchema.safeParse(json);
    if (!parsed.success) return null;
    return { hostId: parsed.data.h, hostName: parsed.data.n, pairingCode: parsed.data.c };
  } catch {
    return null;
  }
}

/** 规范化中继地址：去掉末尾斜杠，只接受 http/https。 */
export function normalizeRelayHttpUrl(relayUrl: string): string {
  const url = new URL(relayUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("relay url must be http(s)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** 由中继 http(s) 地址推导 WebSocket 地址。 */
export function relayWebSocketUrl(
  relayUrl: string,
  path: string,
  query: Record<string, string>,
): string {
  const url = new URL(`${normalizeRelayHttpUrl(relayUrl)}${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}
