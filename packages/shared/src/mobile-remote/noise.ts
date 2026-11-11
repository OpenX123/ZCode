/**
 * Noise_XX_25519_ChaChaPoly_SHA256（Noise 规范 rev34）的最小实现。
 *
 * 只实现手机远控用到的 XX 模式：
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 * 握手完成后 split 出两个方向的 CipherState。原语全部来自 @noble，
 * 不自创密码学构造；本文件只负责按规范编排状态机。
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256";
const DH_LEN = 32;
const TAG_LEN = 16;
/** Noise 规定 nonce 达到 2^64-1 前必须重新握手；手机远控单连接远达不到，取安全整数上限。 */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export interface NoiseKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

export function generateNoiseKeyPair(): NoiseKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function noiseKeyPairFromSecret(secretKey: Uint8Array): NoiseKeyPair {
  if (secretKey.length !== DH_LEN) throw new NoiseError("invalid secret key length");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function nonceBytes(n: number): Uint8Array {
  // ChaChaPoly 的 Noise nonce：4 字节 0 + 8 字节小端计数器。
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, n >>> 0, true);
  view.setUint32(8, Math.floor(n / 0x1_0000_0000), true);
  return nonce;
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, publicKey);
}

/** Noise HKDF 与 RFC 5869（salt=chainingKey、info 为空）的前若干输出块等价。 */
function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, ikm, chainingKey, new Uint8Array(0), 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

export class CipherState {
  private n = 0;

  constructor(private readonly key: Uint8Array | null) {}

  hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted");
    const out = chacha20poly1305(this.key, nonceBytes(this.n), ad).encrypt(plaintext);
    this.n += 1;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted");
    let out: Uint8Array;
    try {
      out = chacha20poly1305(this.key, nonceBytes(this.n), ad).decrypt(ciphertext);
    } catch {
      // 解密失败时 nonce 不前进；调用方必须断开连接，不能重试同一 nonce。
      throw new NoiseError("decrypt failed");
    }
    this.n += 1;
    return out;
  }
}

class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  private cipher = new CipherState(null);

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL_NAME);
    // 协议名恰好 32 字节 = HASHLEN，按规范直接作为初始 h。
    this.h = name.length === 32 ? name : sha256(name);
    this.ck = this.h;
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.ck, ikm);
    this.ck = ck;
    this.cipher = new CipherState(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf(this.ck, new Uint8Array(0));
    return [new CipherState(k1), new CipherState(k2)];
  }

  handshakeHash(): Uint8Array {
    return this.h;
  }
}

export interface NoiseTransport {
  /** 本端 → 对端 */
  send: CipherState;
  /** 对端 → 本端 */
  receive: CipherState;
  remoteStaticKey: Uint8Array;
  handshakeHash: Uint8Array;
}

type Role = "initiator" | "responder";

/**
 * XX 握手状态机。消息必须严格按 1→2→3 顺序调用，错序直接抛错。
 * payload 在第 1 条消息中是明文（规范如此），只能放非敏感内容；配对码放第 3 条。
 */
export class NoiseXXHandshake {
  private readonly ss = new SymmetricState();
  private e: NoiseKeyPair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private step = 0;

  constructor(
    private readonly role: Role,
    private readonly s: NoiseKeyPair,
    prologue: Uint8Array,
    private readonly ephemeralFactory: () => NoiseKeyPair = generateNoiseKeyPair,
  ) {
    this.ss.mixHash(prologue);
  }

  private expect(role: Role, step: number): void {
    if (this.role !== role || this.step !== step) {
      throw new NoiseError(`unexpected handshake step ${this.step} for ${this.role}`);
    }
  }

  /** initiator：-> e */
  writeMessage1(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.expect("initiator", 0);
    this.e = this.ephemeralFactory();
    this.ss.mixHash(this.e.publicKey);
    const body = this.ss.encryptAndHash(payload);
    this.step = 1;
    return concat(this.e.publicKey, body);
  }

  /** responder：读 -> e */
  readMessage1(message: Uint8Array): Uint8Array {
    this.expect("responder", 0);
    if (message.length < DH_LEN) throw new NoiseError("message 1 too short");
    this.re = message.slice(0, DH_LEN);
    this.ss.mixHash(this.re);
    const payload = this.ss.decryptAndHash(message.slice(DH_LEN));
    this.step = 1;
    return payload;
  }

  /** responder：<- e, ee, s, es */
  writeMessage2(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.expect("responder", 1);
    const re = this.requireKey(this.re);
    this.e = this.ephemeralFactory();
    this.ss.mixHash(this.e.publicKey);
    this.ss.mixKey(dh(this.e.secretKey, re));
    const encryptedStatic = this.ss.encryptAndHash(this.s.publicKey);
    this.ss.mixKey(dh(this.s.secretKey, re));
    const body = this.ss.encryptAndHash(payload);
    this.step = 2;
    return concat(this.e.publicKey, encryptedStatic, body);
  }

  /** initiator：读 <- e, ee, s, es；返回 payload，可通过 remoteStaticKey 校验对端身份 */
  readMessage2(message: Uint8Array): Uint8Array {
    this.expect("initiator", 1);
    const e = this.requireKeyPair(this.e);
    if (message.length < DH_LEN + DH_LEN + TAG_LEN + TAG_LEN) {
      throw new NoiseError("message 2 too short");
    }
    this.re = message.slice(0, DH_LEN);
    this.ss.mixHash(this.re);
    this.ss.mixKey(dh(e.secretKey, this.re));
    const encryptedStatic = message.slice(DH_LEN, DH_LEN + DH_LEN + TAG_LEN);
    this.rs = this.ss.decryptAndHash(encryptedStatic);
    this.ss.mixKey(dh(e.secretKey, this.rs));
    const payload = this.ss.decryptAndHash(message.slice(DH_LEN + DH_LEN + TAG_LEN));
    this.step = 2;
    return payload;
  }

  /** initiator：-> s, se；返回消息与传输态 */
  writeMessage3(payload: Uint8Array = new Uint8Array(0)): {
    message: Uint8Array;
    transport: NoiseTransport;
  } {
    this.expect("initiator", 2);
    const re = this.requireKey(this.re);
    const encryptedStatic = this.ss.encryptAndHash(this.s.publicKey);
    this.ss.mixKey(dh(this.s.secretKey, re));
    const body = this.ss.encryptAndHash(payload);
    this.step = 3;
    const [c1, c2] = this.ss.split();
    return {
      message: concat(encryptedStatic, body),
      transport: {
        send: c1,
        receive: c2,
        remoteStaticKey: this.requireKey(this.rs),
        handshakeHash: this.ss.handshakeHash(),
      },
    };
  }

  /** responder：读 -> s, se；返回 payload 与传输态 */
  readMessage3(message: Uint8Array): { payload: Uint8Array; transport: NoiseTransport } {
    this.expect("responder", 2);
    const e = this.requireKeyPair(this.e);
    if (message.length < DH_LEN + TAG_LEN + TAG_LEN) throw new NoiseError("message 3 too short");
    this.rs = this.ss.decryptAndHash(message.slice(0, DH_LEN + TAG_LEN));
    this.ss.mixKey(dh(e.secretKey, this.rs));
    const payload = this.ss.decryptAndHash(message.slice(DH_LEN + TAG_LEN));
    this.step = 3;
    const [c1, c2] = this.ss.split();
    return {
      payload,
      transport: {
        send: c2,
        receive: c1,
        remoteStaticKey: this.rs,
        handshakeHash: this.ss.handshakeHash(),
      },
    };
  }

  /** initiator 在读完第 2 条消息后即可拿到对端静态公钥，用于在发送第 3 条前校验主机身份。 */
  get remoteStaticKey(): Uint8Array | null {
    return this.rs;
  }

  private requireKey(key: Uint8Array | null): Uint8Array {
    if (!key) throw new NoiseError("handshake key missing");
    return key;
  }

  private requireKeyPair(pair: NoiseKeyPair | null): NoiseKeyPair {
    if (!pair) throw new NoiseError("handshake ephemeral missing");
    return pair;
  }
}

/** 常量时间比较，用于配对码与公钥比对。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
