import type { LocalUsageRange } from "@zcode/shared";
import { useAppUsageStats } from "@/hooks/useUsageStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatAppUsageDuration } from "@/settings/usage-stats/local/appUsageDuration.js";
import { formatCompactNumber, formatPercent } from "@/settings/usage-stats/usageStatsUiParts.js";
import { mapToAppUsageRange } from "@/settings/usage-stats/local/localUsageFormat.js";

const L = "settings.usageStats.local.zcodeMetrics";

/**
 * ZCode 专属指标（会话、轮次、工具错误率等）只来自 agent-db，仅在来源为 全部/ZCode 时渲染。
 * agent-db 只有 7d/30d/all 窗口，标题显示实际使用的窗口，避免与上方范围混淆。
 */
export function ZCodeRuntimeMetrics({ range }: { range: LocalUsageRange }) {
  const { intl, locale } = useZCodeIntl();
  const appRange = mapToAppUsageRange(range);
  const { snapshot } = useAppUsageStats(appRange);
  const summary = snapshot?.summary;
  const unavailable = intl.formatMessage({ id: `${L}.unavailable` });
  const items = [
    {
      id: "sessions",
      value: summary ? formatCompactNumber(locale, summary.totalSessions) : unavailable,
    },
    { id: "turns", value: summary ? formatCompactNumber(locale, summary.totalTurns) : unavailable },
    {
      id: "toolCalls",
      value: summary ? formatCompactNumber(locale, summary.toolCallCount) : unavailable,
    },
    {
      id: "toolErrorRate",
      value: summary ? formatPercent(locale, summary.toolErrorRate) : unavailable,
    },
    {
      id: "ttft",
      value:
        summary?.avgTimeToFirstTokenMs != null
          ? `${(summary.avgTimeToFirstTokenMs / 1000).toFixed(1)}s`
          : "--",
    },
    {
      id: "longestSession",
      value: summary ? formatAppUsageDuration(summary.longestSessionMs, intl) : unavailable,
    },
  ];
  return (
    <section className="rounded-xl bg-surface px-3 py-3" data-testid="zcode-runtime-metrics">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: `${L}.title` })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: `${L}.subtitle` },
            { range: intl.formatMessage({ id: `settings.usage.range.${appRange}` }) },
          )}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.id} className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: `${L}.${item.id}` })}
            </span>
            <span className="truncate text-ui-base font-medium tabular-nums text-foreground">
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
