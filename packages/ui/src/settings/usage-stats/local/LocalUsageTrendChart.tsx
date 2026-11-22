import { useCallback, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { LocalUsageDailyPoint } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCompactNumber,
  formatCompactTokenUsage,
  formatDay,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  formatCostUsd,
  type LocalUsageTrendMetric,
} from "@/settings/usage-stats/local/localUsageFormat.js";

// XAxis 首尾刻度以绘图区边界为中心向两侧延伸；左右保留 24px 安全区，桌面与手机 Web 都能完整显示日期。
const TREND_CHART_MARGIN = { top: 8, right: 24, left: 24 } as const;

const METRIC_FIELD: Record<LocalUsageTrendMetric, "totalTokens" | "requestCount" | "costUsd"> = {
  tokens: "totalTokens",
  requests: "requestCount",
  cost: "costUsd",
};

function shouldShowAxisLabel(index: number, total: number): boolean {
  if (total <= 14) return true;
  const step = total > 120 ? 30 : total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

/** 按日柱状趋势；Recharts 由面板 lazy 加载（Electron Linux 启动期不能同步引入 decimal.js）。 */
export function LocalUsageTrendChart({
  daily,
  metric,
}: {
  daily: LocalUsageDailyPoint[];
  metric: LocalUsageTrendMetric;
}) {
  const { intl, locale } = useZCodeIntl();
  const label = intl.formatMessage({ id: `settings.usageStats.local.trend.metric.${metric}` });
  const chartConfig = useMemo<ChartConfig>(
    () => ({ value: { label, color: "var(--color-usage-chart-1)" } }),
    [label],
  );
  // Recharts 会把 data 写入内部 store，稳定派生数组避免父组件重渲染时反复 dispatch。
  const data = useMemo(
    () =>
      daily.map((point) => ({
        label: formatDay(locale, point.date),
        value: point[METRIC_FIELD[metric]],
      })),
    [daily, locale, metric],
  );
  const formatValue = useCallback(
    (value: number) =>
      metric === "cost"
        ? formatCostUsd(locale, value)
        : metric === "tokens"
          ? formatCompactTokenUsage(locale, value)
          : formatCompactNumber(locale, value),
    [locale, metric],
  );
  const tickFormatter = useCallback(
    (value: string, index: number) => (shouldShowAxisLabel(index, data.length) ? value : ""),
    [data.length],
  );
  const tooltipContent = useMemo(
    () => (
      <ChartTooltipContent
        hideIndicator
        formatter={(value) => (
          <span className="font-mono font-medium tabular-nums text-foreground">
            {formatValue(Number(value))}
          </span>
        )}
      />
    ),
    [formatValue],
  );

  return (
    <ChartContainer config={chartConfig} className="h-52 w-full">
      <BarChart accessibilityLayer data={data} margin={TREND_CHART_MARGIN}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval={0}
          minTickGap={0}
          tickMargin={8}
          tickFormatter={tickFormatter}
        />
        <YAxis hide />
        <ChartTooltip cursor={false} content={tooltipContent} />
        <Bar dataKey="value" fill="var(--color-value)" radius={[3, 3, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ChartContainer>
  );
}
