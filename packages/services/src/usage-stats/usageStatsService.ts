import { join } from "node:path";
import {
  localUsageRequestSchema,
  localUsageSnapshotSchema,
  modelPriceSyncResultSchema,
  setModelPriceOverrideRequestSchema,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { aggregateLocalUsage } from "./local/localUsageAggregator.js";
import {
  resolveClaudeProjectDirs,
  resolveCodexHome,
  resolveUsageStatsDataDir,
} from "./local/localUsagePaths.js";
import { LocalUsageScanner } from "./local/localUsageScanner.js";
import { ModelPricingStore } from "./local/modelPricingStore.js";
import type { IUsageStatsService } from "./usageStats.js";

const logger = createServiceLogger("usage-stats");

export interface LocalUsageServiceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** 覆盖缓存/价格文件目录（测试用）。 */
  dataDir?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * App Usage 只来自会话运行时的本地统计，不请求账号权益服务；
 * 本机多来源用量由 LocalUsageScanner（日志游标）与 ModelPricingStore（价格）各自持有状态。
 */
export function createUsageStatsService(dependencies: {
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  localUsage?: LocalUsageServiceOptions;
}): IUsageStatsService {
  const options = dependencies.localUsage ?? {};
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const dataDir = options.dataDir ?? resolveUsageStatsDataDir(env);
  const scanner = new LocalUsageScanner({
    cacheFile: join(dataDir, "local-usage-cache.json"),
    claudeProjectDirs: () => resolveClaudeProjectDirs(env),
    codexHome: () => resolveCodexHome(env),
    now,
    warn: (message, meta) => logger.warn(undefined, message, meta),
    fetchZCodeNative: async (timeZone) => {
      try {
        const snapshot = await dependencies.zcodeAgentService.getAppUsageStats({
          range: "all",
          timeZone,
        });
        // 旧 CLI 不返回 additive 字段时视为不可用，避免把映射清空。
        if (!snapshot.usageFacts || !snapshot.externalSessions) return null;
        return { facts: snapshot.usageFacts, externalSessions: snapshot.externalSessions };
      } catch (error) {
        // 没有活动 workspace 时 CLI 不可达：沿用缓存中的原生聚合与会话映射。
        logger.info(undefined, "[usage-stats] ZCode 原生用量暂不可用，沿用缓存", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  });
  const pricingStore = new ModelPricingStore({
    file: join(dataDir, "model-pricing.json"),
    fetch: options.fetch,
    now,
  });

  return {
    getAppUsageSnapshot: (request) => dependencies.zcodeAgentService.getAppUsageStats(request),

    async getLocalUsageSnapshot(rawRequest) {
      const request = localUsageRequestSchema.parse(rawRequest);
      const timeZone = request.timeZone?.trim() || defaultTimeZone();
      const index = await scanner.scan(timeZone);
      const { tables, syncedAt } = await pricingStore.getTables();
      return localUsageSnapshotSchema.parse(
        aggregateLocalUsage({
          index,
          request,
          timeZone,
          pricing: tables,
          pricingSyncedAt: syncedAt,
          now: now(),
        }),
      );
    },

    async setModelPriceOverride(rawRequest) {
      const request = setModelPriceOverrideRequestSchema.parse(rawRequest);
      await pricingStore.setOverride(request.modelId, request.price);
    },

    async syncModelPrices() {
      const result = await pricingStore.syncFromModelsDev();
      logger.info(undefined, "[usage-stats] 已从 models.dev 同步价格", { modelCount: result.modelCount });
      return modelPriceSyncResultSchema.parse(result);
    },
  };
}
