import { z } from "zod";

export const GITHUB_RELEASE_ROOT = "https://github.com/OpenX123/ZCode/releases";
export const GITHUB_UPDATE_MANIFEST_URL = `${GITHUB_RELEASE_ROOT}/latest/download/ycode-update.json`;
export const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

const assetSchema = z
  .object({
    platform: z.enum(["darwin", "win32"]),
    arch: z.enum(["arm64", "x64"]),
    fileName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.(?:dmg|exe)$/u),
    url: z.string(),
    size: z.number().int().positive().max(MAX_INSTALLER_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
    releaseUrl: z.string(),
    assets: z.array(assetSchema).length(4),
  })
  .strict();
export type GithubUpdateAsset = z.infer<typeof assetSchema>;
export type GithubUpdateManifest = z.infer<typeof manifestSchema>;

/** 不允许 URL 规范化掩盖凭据、查询参数、编码路径穿越或非本仓库资源。 */
export function parseGithubUpdateManifest(input: unknown): GithubUpdateManifest {
  const manifest = manifestSchema.parse(input);
  const tag = `v${manifest.version}`;
  if (manifest.releaseUrl !== `${GITHUB_RELEASE_ROOT}/tag/${tag}`) {
    throw new Error("更新清单的 Release 地址与本仓库版本不匹配");
  }
  const targets = new Set<string>();
  for (const asset of manifest.assets) {
    const key = `${asset.platform}-${asset.arch}`;
    if (targets.has(key)) throw new Error(`更新清单包含重复平台：${key}`);
    targets.add(key);
    const expectedFileName = `YCode-${manifest.version}-${asset.platform === "darwin" ? "mac" : "win"}-${asset.arch}.${asset.platform === "darwin" ? "dmg" : "exe"}`;
    if (
      asset.fileName !== expectedFileName ||
      asset.url !== `${GITHUB_RELEASE_ROOT}/download/${tag}/${asset.fileName}`
    ) {
      throw new Error(`更新安装器地址或格式不属于当前 Release：${asset.fileName}`);
    }
  }
  return manifest;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (version: string) => {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version))
      throw new Error("无法识别桌面版本号");
    return version.split(".").map((part) => BigInt(part));
  };
  const next = parts(candidate);
  const previous = parts(current);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== previous[i]) return next[i]! > previous[i]!;
  }
  return false;
}
