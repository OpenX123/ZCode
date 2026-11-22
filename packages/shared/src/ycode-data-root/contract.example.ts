import { chooseDataRootDirName, readYCodeEnv } from "./contract.js";

/** 示例：未迁移时继续使用旧目录，同时尊重 YCODE_DATA_BASE_DIR。 */
export function describeDataRoot(env: Record<string, string | undefined>): string {
  const base = readYCodeEnv(env, "DATA_BASE_DIR") ?? "~";
  return `${base}/${chooseDataRootDirName({ nextExists: false, legacyExists: true })}`;
}
