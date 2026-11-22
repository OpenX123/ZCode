/**
 * usage-stats-local 标准调用示例：扫描（单飞、增量）→ 读取价格表 → 纯函数聚合。
 */
import type { LocalUsageRequest, LocalUsageSnapshot } from "@zcode/shared";
import { aggregateLocalUsage, type LocalUsageScanner, type ModelPricingStore } from "./index.js";

export async function exampleUsageStatsLocal(
  scanner: LocalUsageScanner,
  pricingStore: ModelPricingStore,
  request: LocalUsageRequest,
): Promise<LocalUsageSnapshot> {
  const timeZone = request.timeZone ?? "UTC";
  const index = await scanner.scan(timeZone);
  const { tables, syncedAt } = await pricingStore.getTables();
  return aggregateLocalUsage({
    index,
    request,
    timeZone,
    pricing: tables,
    pricingSyncedAt: syncedAt,
    now: Date.now(),
  });
}
