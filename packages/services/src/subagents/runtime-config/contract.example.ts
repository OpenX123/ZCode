import type { ConfigReader, SubagentRuntimeConfigCache, Workspace } from "./contract.js";
import { createSubagentRuntimeConfigCache } from "./index.js";

/** 展示 service 实例的准备、父轮读取与关闭；实际 service 在整个 Host 生命周期复用缓存。 */
export async function exampleSubagentRuntimeConfig(reader: ConfigReader, workspace: Workspace) {
  const cache: SubagentRuntimeConfigCache = createSubagentRuntimeConfigCache(reader);
  try {
    await cache.prepare(workspace);
    return await cache.read(workspace);
  } finally {
    cache.dispose();
  }
}
