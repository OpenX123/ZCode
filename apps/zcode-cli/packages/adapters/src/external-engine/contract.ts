import type { Logger } from "@zcode/contracts";
import type { ExternalEngineProcessPool } from "./process-pool.js";
export type { ExternalEnginePort } from "@zcode/contracts";
export interface ExternalEngineAdapterOptions {
  env?: NodeJS.ProcessEnv;
  executable?: string;
  /** CLI 进程级进程池：备用进程领用/补位与闲置关闭；缺省时行为同 1.0.x（无备用、无闲置关闭）。 */
  processPool?: ExternalEngineProcessPool;
  /** 本地性能事件（info，无正文）。 */
  logger?: Logger;
}
