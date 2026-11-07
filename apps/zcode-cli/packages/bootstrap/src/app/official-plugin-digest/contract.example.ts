/**
 * cli-official-plugin-digest 标准调用示例：seed 前取得逐文件摘要，只在签名变化时读取内容。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OfficialPluginDigestContract, OfficialPluginFileStat } from "./contract.js";

export function exampleResolveDigests(
  contract: OfficialPluginDigestContract,
  input: { listFiles: () => OfficialPluginFileStat[]; rootPath: string; storageRoot: string },
) {
  return contract.resolveOfficialPluginFileDigests({
    appVersion: "1.1.0",
    definition: { name: "documents", version: "0.2.0" },
    hashFile: (file) => createHash("sha256").update(readFileSync(file.sourcePath)).digest("hex"),
    listFiles: input.listFiles,
    rootPath: input.rootPath,
    storageRoot: input.storageRoot,
  });
}
