/**
 * cli-official-plugin-digest 对外契约：文件系统来源内置插件的逐文件摘要。
 * 唯一使用方是内置插件 seed（app/bundled-plugins.ts）。规则见 docs/design/v2/plugin-compat.md
 * 「内置插件摘要缓存」与 docs/desktop/engine-performance-1.1-spec.md §2。
 */
import type { Logger } from "@zcode/contracts";

/** memory：本进程已算过；persisted：按文件统计签名复用持久化结果；hashed：读文件重新哈希。 */
export type OfficialPluginDigestSource = "memory" | "persisted" | "hashed";

export interface OfficialPluginFileStat {
  /** 已按 seed 规则归一化的文件权限。 */
  mode: number;
  mtimeMs: number;
  /** 相对插件根目录的 POSIX 路径。 */
  path: string;
  size: number;
  sourcePath: string;
}

export interface OfficialPluginFileDigest {
  mode: number;
  path: string;
  sha256: string;
  sourcePath: string;
}

export interface ResolveOfficialPluginFileDigestsInput {
  /** `ZCODE_APP_VERSION`；独立 CLI 缺省时只依赖文件统计签名。 */
  appVersion?: string;
  definition: { name: string; version: string };
  /** 计算单个文件的 SHA-256（读取文件内容），只在签名不匹配时调用。 */
  hashFile: (file: OfficialPluginFileStat) => string;
  /** 枚举并 stat 插件文件（不读内容），按 path 排序。 */
  listFiles: () => OfficialPluginFileStat[];
  logger?: Logger;
  rootPath: string;
  /** 插件存储根目录；持久化文件为其下的 official-plugin-digests.json。 */
  storageRoot: string;
}

export interface OfficialPluginDigestContract {
  /**
   * 返回逐文件摘要，顺序与 listFiles 一致。同一进程同一（应用版本、根目录、插件名/版本）只计算一次；
   * 新进程在文件统计签名一致时复用持久化结果。持久化写入失败只记 warn，不影响返回值。
   */
  resolveOfficialPluginFileDigests(input: ResolveOfficialPluginFileDigestsInput): {
    files: OfficialPluginFileDigest[];
    source: OfficialPluginDigestSource;
  };
}
