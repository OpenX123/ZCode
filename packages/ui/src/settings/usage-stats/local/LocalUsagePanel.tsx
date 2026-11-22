import { RefreshCcw } from "lucide-react";
import { lazy, useMemo, useState } from "react";
import {
  LOCAL_USAGE_RANGES,
  LOCAL_USAGE_SOURCES,
  type LocalUsageRange,
  type LocalUsageSnapshot,
  type LocalUsageSource,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useLocalUsageStats } from "@/settings/usage-stats/local/useLocalUsageStats.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatPercent,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { LocalUsagePricingTab } from "@/settings/usage-stats/local/LocalUsagePricingTab.js";
import {
  LocalUsageModelsTable,
  LocalUsageProjectsTable,
  LocalUsageRequestsTable,
} from "@/settings/usage-stats/local/LocalUsageTables.js";
import { ZCodeRuntimeMetrics } from "@/settings/usage-stats/local/ZCodeRuntimeMetrics.js";
import {
  formatCostUsd,
  formatDateTime,
  type LocalUsageTrendMetric,
} from "@/settings/usage-stats/local/localUsageFormat.js";

// Recharts 模块初始化会触发 decimal.js-light 校验，在 Electron Linux 容器里会阻断 renderer 启动；
// 图表按需加载并由局部边界隔离（与原 App Usage 图表一致）。
const LocalUsageTrendChart = lazy(() =>
  import("@/settings/usage-stats/local/LocalUsageTrendChart.js").then((module) => ({
    default: module.LocalUsageTrendChart,
  })),
);

const L = "settings.usageStats.local";
const TREND_METRICS: LocalUsageTrendMetric[] = ["tokens", "requests", "cost"];
const DETAIL_TABS = ["models", "projects", "requests", "pricing"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

function todayKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function PillTabs<T extends string>({
  value,
  options,
  onChange,
  label,
  renderLabel,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
  renderLabel: (value: T) => string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} className="shrink-0">
      <TabsList aria-label={label} className={USAGE_STATS_TABS_LIST_CLASS}>
        {options.map((option) => (
          <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
            {renderLabel(option)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function SummaryCard({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface px-3.5 py-3">
      <div className="truncate text-ui-sm text-foreground-subtle">{label}</div>
      <div className="mt-1.5 truncate text-ui-xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {helper ? (
        <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">{helper}</div>
      ) : null}
    </div>
  );
}

function SummaryCards({ snapshot }: { snapshot: LocalUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const { summary } = snapshot;
  const tokens = (value: number) => formatCompactTokenUsage(locale, value);
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <SummaryCard
        label={intl.formatMessage({ id: `${L}.card.cost` })}
        value={formatCostUsd(locale, summary.costUsd)}
        helper={
          summary.unpricedTokens > 0
            ? intl.formatMessage(
                { id: `${L}.card.costUnpriced` },
                { tokens: tokens(summary.unpricedTokens) },
              )
            : intl.formatMessage({ id: `${L}.estimateLabel` })
        }
      />
      <SummaryCard
        label={intl.formatMessage({ id: `${L}.card.requests` })}
        value={formatCompactNumber(locale, summary.requestCount)}
      />
      <SummaryCard
        label={intl.formatMessage({ id: `${L}.card.tokens` })}
        value={tokens(summary.totalTokens)}
        helper={intl.formatMessage(
          { id: `${L}.card.tokensDetail` },
          { input: tokens(summary.inputTokens), output: tokens(summary.outputTokens) },
        )}
      />
      <SummaryCard
        label={intl.formatMessage({ id: `${L}.card.cacheHitRate` })}
        value={formatPercent(locale, summary.cacheHitRate)}
        helper={intl.formatMessage(
          { id: `${L}.card.cacheDetail` },
          { read: tokens(summary.cacheReadTokens), write: tokens(summary.cacheWriteTokens) },
        )}
      />
    </div>
  );
}

export function LocalUsagePanel() {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `${L}.${id}` }, values);
  const [source, setSource] = useState<LocalUsageSource>("all");
  const [range, setRange] = useState<LocalUsageRange>("7d");
  const [customStartDate, setCustomStartDate] = useState<string>(() => todayKey());
  const [customEndDate, setCustomEndDate] = useState<string>(() => todayKey());
  const [trendMetric, setTrendMetric] = useState<LocalUsageTrendMetric>("tokens");
  const [detailTab, setDetailTab] = useState<DetailTab>("models");
  const query = useMemo(
    () => ({
      source,
      range,
      customStartDate: range === "custom" ? customStartDate || null : null,
      customEndDate: range === "custom" ? customEndDate || null : null,
    }),
    [customEndDate, customStartDate, range, source],
  );
  const { snapshot, loading, error, refresh, setModelPrice, syncPrices } =
    useLocalUsageStats(query);
  const showZCodeMetrics = source === "all" || source === "zcode";
  const hasUsage = (snapshot?.summary.requestCount ?? 0) > 0;

  return (
    <div className="space-y-4" data-testid="local-usage-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs
          value={source}
          options={LOCAL_USAGE_SOURCES}
          onChange={setSource}
          label={t("sourceLabel")}
          renderLabel={(option) => t(`source.${option}`)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <PillTabs
            value={range}
            options={LOCAL_USAGE_RANGES}
            onChange={setRange}
            label={t("rangeLabel")}
            renderLabel={(option) => t(`range.${option}`)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("refresh")}
            title={t("refresh")}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCcw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
        </div>
      </div>

      {range === "custom" ? (
        <div className="flex flex-wrap items-center justify-end gap-2 text-ui-sm text-foreground-subtle">
          <label className="flex items-center gap-1.5">
            {t("customStart")}
            <Input
              type="date"
              size="sm"
              className="w-36"
              value={customStartDate}
              max={customEndDate || undefined}
              onChange={(event) => setCustomStartDate(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t("customEnd")}
            <Input
              type="date"
              size="sm"
              className="w-36"
              value={customEndDate}
              min={customStartDate || undefined}
              onChange={(event) => setCustomEndDate(event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="text-ui-base text-destructive">
          {t("loadFailed", { error })}
        </div>
      ) : null}

      {!snapshot ? (
        <UsageEmptyState
          title={loading ? t("loading") : t("emptyTitle")}
          description={loading ? t("estimateLabel") : t("emptyDescription")}
        />
      ) : (
        <>
          {!snapshot.scan.zcodeNativeAvailable && source !== "claude-code" && source !== "codex" ? (
            <div
              role="status"
              className="rounded-lg bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground"
            >
              {t("notice.zcodeUnavailable")}
            </div>
          ) : null}
          <SummaryCards snapshot={snapshot} />

          <section className="rounded-xl bg-surface px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">
                {t("trend.title")}
              </h3>
              <PillTabs
                value={trendMetric}
                options={TREND_METRICS}
                onChange={setTrendMetric}
                label={t("trend.title")}
                renderLabel={(option) => t(`trend.metric.${option}`)}
              />
            </div>
            {hasUsage ? (
              <UsageChartLoadBoundary
                scope="settings.usage.local-trend-chart"
                resetKeys={[snapshot.generatedAt, trendMetric]}
                loadingDescription={t("loading")}
              >
                <LocalUsageTrendChart daily={snapshot.daily} metric={trendMetric} />
              </UsageChartLoadBoundary>
            ) : (
              <UsageEmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
            )}
          </section>

          <UsageHeatmap
            locale={locale}
            intl={intl}
            weeks={snapshot.heatmapWeeks}
            countMetric="requests"
            weekCount={53}
          />

          <section className="rounded-xl bg-surface py-2">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2">
              <PillTabs
                value={detailTab}
                options={DETAIL_TABS}
                onChange={setDetailTab}
                label={t("tab.models")}
                renderLabel={(option) => t(`tab.${option}`)}
              />
              <span className="text-ui-sm text-foreground-subtle">{t("estimateLabel")}</span>
            </div>
            {detailTab === "models" ? <LocalUsageModelsTable rows={snapshot.models} /> : null}
            {detailTab === "projects" ? <LocalUsageProjectsTable rows={snapshot.projects} /> : null}
            {detailTab === "requests" ? (
              <LocalUsageRequestsTable rows={snapshot.requests} total={snapshot.requestTotal} />
            ) : null}
            {detailTab === "pricing" ? (
              <LocalUsagePricingTab
                rows={snapshot.pricing}
                syncedAt={snapshot.pricingSyncedAt}
                onSave={setModelPrice}
                onSync={syncPrices}
              />
            ) : null}
          </section>

          {showZCodeMetrics ? <ZCodeRuntimeMetrics range={range} /> : null}

          <div className="flex flex-wrap justify-between gap-2 text-ui-sm text-foreground-subtle">
            <span>
              {t("scanInfo", {
                claude: formatCompactNumber(locale, snapshot.scan.claudeFiles),
                codex: formatCompactNumber(locale, snapshot.scan.codexFiles),
                time: formatDateTime(locale, snapshot.scan.scannedAt),
              })}
            </span>
            {snapshot.scan.malformedLines > 0 ? (
              <span>
                {t("notice.malformed", {
                  count: formatCompactNumber(locale, snapshot.scan.malformedLines),
                })}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
