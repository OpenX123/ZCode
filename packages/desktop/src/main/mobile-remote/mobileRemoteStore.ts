/**
 * 手机远控持久化状态的唯一写入者：主机密钥、中继配置、已配对设备。
 * 落盘 `<dir>/state.json`，权限 0600，原子写（tmp + rename）。
 * 文件损坏时生成新主机密钥（等价于全部设备需要重新配对），不静默沿用部分数据。
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateNoiseKeyPair,
  noiseKeyPairFromSecret,
  type NoiseKeyPair,
} from "@zcode/shared/mobile-remote";

const deviceSchema = z.object({
  id: z.string().min(40).max(64),
  name: z.string().max(80),
  pairedAt: z.number(),
  lastSeenAt: z.number().optional(),
});

const stateSchema = z.object({
  version: z.literal(1),
  hostSecretKey: z.string(),
  enabled: z.boolean(),
  relayUrl: z.string(),
  relayToken: z.string(),
  devices: z.array(deviceSchema),
});

export type MobileRemoteStoredDevice = z.infer<typeof deviceSchema>;
type PersistedState = z.infer<typeof stateSchema>;

export interface MobileRemoteState {
  hostKey: NoiseKeyPair;
  enabled: boolean;
  relayUrl: string;
  relayToken: string;
  devices: MobileRemoteStoredDevice[];
}

export interface MobileRemoteStore {
  load(): Promise<MobileRemoteState>;
  save(state: MobileRemoteState): Promise<void>;
}

function freshState(): MobileRemoteState {
  return { hostKey: generateNoiseKeyPair(), enabled: false, relayUrl: "", relayToken: "", devices: [] };
}

export function createMobileRemoteStore(dir: string): MobileRemoteStore {
  const filePath = join(dir, "state.json");
  // 串行化写入，避免并发 save 交错 rename 导致旧状态覆盖新状态。
  let writeChain: Promise<void> = Promise.resolve();

  async function persist(state: MobileRemoteState): Promise<void> {
    const persisted: PersistedState = {
      version: 1,
      hostSecretKey: bytesToBase64Url(state.hostKey.secretKey),
      enabled: state.enabled,
      relayUrl: state.relayUrl,
      relayToken: state.relayToken,
      devices: state.devices,
    };
    const tempPath = join(dir, `.state-${randomBytes(6).toString("hex")}.tmp`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, filePath);
      // Windows 上 chmod 只影响只读位，忽略失败。
      await chmod(filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        const state = freshState();
        await persist(state);
        return state;
      }
      try {
        const parsed = stateSchema.parse(JSON.parse(raw));
        return {
          hostKey: noiseKeyPairFromSecret(base64UrlToBytes(parsed.hostSecretKey)),
          enabled: parsed.enabled,
          relayUrl: parsed.relayUrl,
          relayToken: parsed.relayToken,
          devices: parsed.devices,
        };
      } catch {
        const state = freshState();
        await persist(state);
        return state;
      }
    },
    save(state) {
      writeChain = writeChain.catch(() => undefined).then(() => persist(state));
      return writeChain;
    },
  };
}
