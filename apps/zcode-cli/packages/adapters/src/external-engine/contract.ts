import type { Logger } from "@zcode/contracts";
import type { ExternalEngineProcessPool } from "./process-pool.js";
import type { ExternalEngineConfigCatalog } from "./config-catalog.js";
export type { ExternalEnginePort } from "@zcode/contracts";
export interface ExternalEngineAdapterOptions {
  env?: NodeJS.ProcessEnv;
  executable?: string;
  /** CLI 进程级进程池：备用进程领用/补位与闲置关闭；缺省时行为同 1.0.x（无备用、无闲置关闭）。 */
  processPool?: ExternalEngineProcessPool;
  /** CLI 进程级选项清单缓存（W4）；缺省时新会话 connecting 期间不发布缓存清单。 */
  configCatalog?: ExternalEngineConfigCatalog;
  /** 本地性能事件（info，无正文）。 */
  logger?: Logger;
}
