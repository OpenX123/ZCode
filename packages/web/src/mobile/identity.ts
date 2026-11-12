/**
 * 手机端本机身份与已配对主机列表，仅存于本机 localStorage，不上传。
 * 设备私钥丢失（清除网站数据）等价于该手机需要重新扫码配对。
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateNoiseKeyPair,
  noiseKeyPairFromSecret,
  type NoiseKeyPair,
} from "@zcode/shared/mobile-remote";
import type { PairedHost } from "./contract.js";

const STORAGE_KEY = "zcode-mobile-remote:v1";


interface StoredState {
  deviceSecret: string;
  hosts: PairedHost[];
}

function readState(): StoredState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (typeof parsed.deviceSecret !== "string" || !Array.isArray(parsed.hosts)) return null;
    return {
      deviceSecret: parsed.deviceSecret,
      hosts: parsed.hosts.filter(
        (host): host is PairedHost =>
          typeof host?.hostId === "string" &&
          typeof host.hostName === "string" &&
          typeof host.relayUrl === "string",
      ),
    };
  } catch {
    return null;
  }
}

function writeState(state: StoredState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function ensureState(): StoredState {
  const existing = readState();
  if (existing) return existing;
  const state = { deviceSecret: bytesToBase64Url(generateNoiseKeyPair().secretKey), hosts: [] };
  writeState(state);
  return state;
}

export function loadDeviceKey(): NoiseKeyPair {
  return noiseKeyPairFromSecret(base64UrlToBytes(ensureState().deviceSecret));
}

export function listPairedHosts(): PairedHost[] {
  return ensureState().hosts;
}

export function savePairedHost(host: PairedHost): void {
  const state = ensureState();
  writeState({ ...state, hosts: [host, ...state.hosts.filter((h) => h.hostId !== host.hostId)] });
}

export function rememberWindow(hostId: string, windowId: number): void {
  const state = ensureState();
  writeState({
    ...state,
    hosts: state.hosts.map((h) => (h.hostId === hostId ? { ...h, lastWindowId: windowId } : h)),
  });
}

export function removePairedHost(hostId: string): void {
  const state = ensureState();
  writeState({ ...state, hosts: state.hosts.filter((h) => h.hostId !== hostId) });
}

/** 握手 hello 中的设备名，只用于桌面设备列表展示。 */
export function describeDevice(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac 浏览器";
  if (/Windows/.test(ua)) return "Windows 浏览器";
  return "浏览器";
}
