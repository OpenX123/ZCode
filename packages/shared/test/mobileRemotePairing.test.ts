import { describe, expect, it } from "vitest";
import {
  buildMobileRemotePairingUrl,
  formatMobileRemotePairingCode,
  mobileRemotePairingCodeFromBytes,
  mobileRemotePairingLookupKey,
  normalizeMobileRemotePairingCode,
  parseMobileRemotePairingInput,
} from "../src/mobile-remote/index.js";

const HOST_ID = "h2LUSmZHmEzKJFBTyJ_tU1H6sz8zYmNs6Op9rwNzHig";

describe("mobile remote pairing code", () => {
  it("由随机字节生成 8 位 Crockford Base32，不含 I L O U", () => {
    const code = mobileRemotePairingCodeFromBytes(new Uint8Array([0, 1, 18, 21, 24, 27, 31, 255]));
    expect(code).toBe("01JNRVZZ");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("规范化忽略大小写、空格与连字符，并纠正易混淆字符", () => {
    expect(normalizeMobileRemotePairingCode(" k7m2-9qxd ")).toBe("K7M29QXD");
    expect(normalizeMobileRemotePairingCode("o1l2 i3k4")).toBe("011213K4");
    expect(normalizeMobileRemotePairingCode("K7M2-9QX")).toBeNull();
    expect(normalizeMobileRemotePairingCode("K7M2-9QXU")).toBeNull();
  });

  it("展示格式为 XXXX-XXXX", () => {
    expect(formatMobileRemotePairingCode("K7M29QXD")).toBe("K7M2-9QXD");
  });

  it("查询键对同一码的不同写法一致，不同码不同，且不包含明文", () => {
    const key = mobileRemotePairingLookupKey("K7M2-9QXD");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mobileRemotePairingLookupKey("k7m29qxd")).toBe(key);
    expect(mobileRemotePairingLookupKey("K7M29QXE")).not.toBe(key);
    expect(key).not.toContain("K7M2");
    expect(() => mobileRemotePairingLookupKey("bad")).toThrow();
  });
});

describe("mobile remote pairing input", () => {
  const url = buildMobileRemotePairingUrl("https://relay.example.com/", {
    hostId: HOST_ID,
    hostName: "Mac",
    pairingCode: "K7M29QXD",
  });

  it("统一输入识别配对链接、配对码，其他内容返回 null", () => {
    expect(parseMobileRemotePairingInput(url)).toEqual({
      kind: "link",
      relayOrigin: "https://relay.example.com",
      payload: { hostId: HOST_ID, hostName: "Mac", pairingCode: "K7M29QXD" },
    });
    expect(parseMobileRemotePairingInput("k7m2 9qxd")).toEqual({ kind: "code", code: "K7M29QXD" });
    expect(parseMobileRemotePairingInput("https://relay.example.com/m/")).toBeNull();
    expect(parseMobileRemotePairingInput("javascript:alert(1)")).toBeNull();
    expect(parseMobileRemotePairingInput("hello")).toBeNull();
  });
});
