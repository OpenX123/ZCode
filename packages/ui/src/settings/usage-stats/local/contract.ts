/**
 * usage-stats-local-ui 对外契约：设置页「使用统计」本机多来源面板。
 * - LocalUsagePanel：挂载即请求一次快照，停留期间每 30s 刷新，卸载/页面隐藏后不再请求。
 * - 来源、范围、tab 是组件局部状态，不是服务端事实；数据只经 IUsageStatsService（useServices）读取。
 * - i18n.ts 提供 settings.usageStats.local.* 文案，由 locales 合并。
 */
export type { LocalUsageQuery } from "./useLocalUsageStats.js";
export type { LocalUsageTrendMetric } from "./localUsageFormat.js";
