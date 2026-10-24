import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";

/** 用量只来自会话运行时的本地统计，不请求账号权益服务。 */
export function createUsageStatsService(dependencies: {
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
}): IUsageStatsService {
  return {
    getAppUsageSnapshot: (request) => dependencies.zcodeAgentService.getAppUsageStats(request),
  };
}
