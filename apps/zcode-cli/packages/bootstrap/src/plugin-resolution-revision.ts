import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigResult } from "@zcode/adapters/config";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// 安装、卸载、更新与市场增删都会改写这两份插件存储记录。
const PLUGIN_STATE_FILES = ["installed_plugins.json", "known_marketplaces.json"] as const;
// 内置插件 seed 新版本目录时会改动官方缓存目录。
const OFFICIAL_PLUGIN_CACHE_DIR = join("cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
const MISSING_STAT = "missing";

/**
 * 插件解析结果的修订号：生效配置中的插件段（启停、抑制内置、选项、额外市场、inline 目录）+
 * 插件存储记录的统计签名。任一插件安装、卸载、更新、启停或恢复内置都会改变其中之一，
 * 调用方据此判断进程内缓存的插件解析结果是否仍然有效。
 */
export async function computePluginResolutionRevision(input: {
  configResult: ConfigResult;
  pluginStorageRoot: string;
}): Promise<string> {
  const stats = await Promise.all(
    [...PLUGIN_STATE_FILES, OFFICIAL_PLUGIN_CACHE_DIR].map((relativePath) =>
      readStatSignature(join(input.pluginStorageRoot, relativePath)),
    ),
  );
  return createHash("sha256")
    .update(JSON.stringify([input.configResult.config.plugins, stats]))
    .digest("hex");
}

async function readStatSignature(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return MISSING_STAT;
  }
}
