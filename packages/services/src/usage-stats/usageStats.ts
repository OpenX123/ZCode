import type {
  AppUsageRequest,
  AppUsageSnapshot,
  LocalUsageRequest,
  LocalUsageSnapshot,
  ModelPriceSyncResult,
  SetModelPriceOverrideRequest,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  /** 本机多来源用量（ZCode / Claude Code / Codex）。调用即触发一次增量扫描（统计页打开时）。 */
  getLocalUsageSnapshot(request: LocalUsageRequest): Promise<LocalUsageSnapshot>;
  /** 手动改价；price=null 恢复默认（同步价或内置价）。 */
  setModelPriceOverride(request: SetModelPriceOverrideRequest): Promise<void>;
  /** 从 models.dev 同步价格；唯一联网入口，仅用户点击触发。 */
  syncModelPrices(): Promise<ModelPriceSyncResult>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
