/**
 * 手输配对码：经中继 `GET /v1/pair/<lookup>` 查到 hostId，之后照常握手，由主机校验配对码。
 * 中继只收到配对码的哈希（spec「配对码查询」）。
 */
import {
  base64UrlToBytes,
  mobileRemotePairingLookupKey,
  normalizeRelayHttpUrl,
  type MobileRemotePairingLookupResult,
} from "@zcode/shared/mobile-remote";
import { MobileRemoteConnectError } from "./contract.js";

export async function lookupMobileRemotePairing(
  relayUrl: string,
  code: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MobileRemotePairingLookupResult> {
  const url = `${normalizeRelayHttpUrl(relayUrl)}/v1/pair/${mobileRemotePairingLookupKey(code)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store" });
  } catch {
    throw new MobileRemoteConnectError("network", "无法连接中继");
  }
  if (response.status === 404) {
    throw new MobileRemoteConnectError("pairing_not_found", "配对码无效或已过期");
  }
  if (response.status === 429) {
    throw new MobileRemoteConnectError("rate_limited", "尝试次数过多，请稍后再试");
  }
  if (!response.ok) {
    throw new MobileRemoteConnectError("network", `中继返回 HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { hostId?: unknown } | null;
  const hostId = typeof body?.hostId === "string" ? body.hostId : "";
  try {
    // hostId 必须是 32 字节公钥，否则视为协议错误，不进入握手。
    if (base64UrlToBytes(hostId).length !== 32) throw new Error("bad host id");
  } catch {
    throw new MobileRemoteConnectError("protocol", "中继返回的主机标识无效");
  }
  return { hostId };
}
