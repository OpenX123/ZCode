import { describe, expect, it } from "vitest";
import { NoiseXXHandshake, noiseKeyPairFromSecret } from "../src/mobile-remote/noise.js";

// 来源：cacophony 测试向量（mcginty/snow tests/vectors/cacophony.txt）中
// Noise_XX_25519_ChaChaPoly_SHA256 的条目，用于确认握手编排与规范逐字节一致。
const vector = {
  prologue: "4a6f686e2047616c74",
  initStatic: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshakeHash: "c8e5f64e846193be2a834104c2a009868d6c9f3bd3c186299888b488b2f1f58e",
  messages: [
    {
      payload: "4c756477696720766f6e204d69736573",
      ciphertext:
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573",
    },
    {
      payload: "4d757272617920526f746862617264",
      ciphertext:
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884381cbad1f276e038c48378ffce2b65285e08d6b68aaa3629a5a8639392490e5b9bd5269c2f1e4f488ed8831161f19b7815528f8982ffe09be9b5c412f8a0db50f8814c7194e83f23dbd8d162c9326ad",
    },
    {
      payload: "462e20412e20486179656b",
      ciphertext:
        "c7195ffacac1307ff99046f219750fc47693e23c3cb08b89c2af808b444850a80ae475b9df0f169ae80a89be0865b57f58c9fea0d4ec82a286427402f113e4b6ae769a1d95941d49b25030",
    },
    { payload: "4361726c204d656e676572", ciphertext: "96763ed773f8e47bb3712f0e29b3060ffc956ffc146cee53d5e1df" },
    {
      payload: "4a65616e2d426170746973746520536179",
      ciphertext: "3e40f15f6f3a46ae446b253bf8b1d9ffb6ed9b174d272328ff91a7e2e5c79c07f5",
    },
  ],
};

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

describe("Noise XX 与 cacophony 测试向量一致", () => {
  it("握手消息、握手哈希与传输消息逐字节一致", () => {
    const initiator = new NoiseXXHandshake(
      "initiator",
      noiseKeyPairFromSecret(hex(vector.initStatic)),
      hex(vector.prologue),
      () => noiseKeyPairFromSecret(hex(vector.initEphemeral)),
    );
    const responder = new NoiseXXHandshake(
      "responder",
      noiseKeyPairFromSecret(hex(vector.respStatic)),
      hex(vector.prologue),
      () => noiseKeyPairFromSecret(hex(vector.respEphemeral)),
    );
    const [m1, m2, m3, m4, m5] = vector.messages;

    const c1 = initiator.writeMessage1(hex(m1!.payload));
    expect(toHex(c1)).toBe(m1!.ciphertext);
    expect(toHex(responder.readMessage1(c1))).toBe(m1!.payload);

    const c2 = responder.writeMessage2(hex(m2!.payload));
    expect(toHex(c2)).toBe(m2!.ciphertext);
    expect(toHex(initiator.readMessage2(c2))).toBe(m2!.payload);

    const done = initiator.writeMessage3(hex(m3!.payload));
    expect(toHex(done.message)).toBe(m3!.ciphertext);
    const accepted = responder.readMessage3(done.message);
    expect(toHex(accepted.payload)).toBe(m3!.payload);

    expect(toHex(done.transport.handshakeHash)).toBe(vector.handshakeHash);
    expect(toHex(accepted.transport.handshakeHash)).toBe(vector.handshakeHash);

    // 握手后 responder 先发（第 4 条），initiator 再发（第 5 条）。
    const c4 = accepted.transport.send.encryptWithAd(new Uint8Array(0), hex(m4!.payload));
    expect(toHex(c4)).toBe(m4!.ciphertext);
    expect(toHex(done.transport.receive.decryptWithAd(new Uint8Array(0), c4))).toBe(m4!.payload);
    const c5 = done.transport.send.encryptWithAd(new Uint8Array(0), hex(m5!.payload));
    expect(toHex(c5)).toBe(m5!.ciphertext);
  });
});
