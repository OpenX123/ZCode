import type { ReactNode } from "react";
import type { LocalUsageModelRow, LocalUsageProjectRow, LocalUsageRequestRow } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCompactNumber,
  formatCompactTokenUsage,
  formatDay,
  formatPercent,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  formatCostUsd,
  formatDateTime,
  shortenCwd,
} from "@/settings/usage-stats/local/localUsageFormat.js";

const L = "settings.usageStats.local";

export interface LocalUsageColumn<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
  className?: string;
}

/** 紧凑数据表：横向溢出只在容器内滚动，手机 Web 不产生页面级横向滚动。 */
export function LocalUsageTable<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: LocalUsageColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <div className="px-3 py-8 text-center text-ui-base text-foreground-subtle">{empty}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-ui-base">
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "whitespace-nowrap px-3 py-2 text-ui-sm font-normal text-foreground-subtle",
                  column.align === "right" ? "text-right" : "text-left",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-border last:border-b-0 hover:bg-surface-hover"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "whitespace-nowrap px-3 py-2 text-foreground",
                    column.align === "right" ? "text-right tabular-nums" : "text-left",
                    column.className,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LocalUsageModelsTable({ rows }: { rows: LocalUsageModelRow[] }) {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `${L}.${id}` });
  const tokens = (value: number) => formatCompactTokenUsage(locale, value);
  return (
    <LocalUsageTable
      rows={rows}
      rowKey={(row) => row.modelId}
      empty={t("emptyDescription")}
      columns={[
        {
          key: "model",
          label: t("col.model"),
          render: (row) => row.modelId,
          className: "font-medium",
        },
        {
          key: "requests",
          label: t("col.requests"),
          align: "right",
          render: (row) => formatCompactNumber(locale, row.requestCount),
        },
        {
          key: "input",
          label: t("col.input"),
          align: "right",
          render: (row) => tokens(row.inputTokens),
        },
        {
          key: "output",
          label: t("col.output"),
          align: "right",
          render: (row) => tokens(row.outputTokens),
        },
        {
          key: "cacheRead",
          label: t("col.cacheRead"),
          align: "right",
          render: (row) => tokens(row.cacheReadTokens),
        },
        {
          key: "cacheWrite",
          label: t("col.cacheWrite"),
          align: "right",
          render: (row) => tokens(row.cacheWriteTokens),
        },
        {
          key: "cost",
          label: t("col.cost"),
          align: "right",
          render: (row) =>
            row.costUsd === null ? (
              <span className="text-foreground-subtle">{t("unpriced")}</span>
            ) : (
              formatCostUsd(locale, row.costUsd)
            ),
        },
        {
          key: "share",
          label: t("col.share"),
          align: "right",
          render: (row) => formatPercent(locale, row.share),
        },
      ]}
    />
  );
}

export function LocalUsageProjectsTable({ rows }: { rows: LocalUsageProjectRow[] }) {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `${L}.${id}` });
  return (
    <LocalUsageTable
      rows={rows}
      rowKey={(row) => row.cwd ?? "__unknown__"}
      empty={t("emptyDescription")}
      columns={[
        {
          key: "project",
          label: t("col.project"),
          render: (row) =>
            row.cwd ? (
              <span title={row.cwd}>{shortenCwd(row.cwd)}</span>
            ) : (
              <span className="text-foreground-subtle">{t("unknownProject")}</span>
            ),
          className: "max-w-[320px] truncate font-medium",
        },
        {
          key: "requests",
          label: t("col.requests"),
          align: "right",
          render: (row) => formatCompactNumber(locale, row.requestCount),
        },
        {
          key: "tokens",
          label: t("col.tokens"),
          align: "right",
          render: (row) => formatCompactTokenUsage(locale, row.totalTokens),
        },
        {
          key: "cost",
          label: t("col.cost"),
          align: "right",
          render: (row) => formatCostUsd(locale, row.costUsd),
        },
        {
          key: "lastActive",
          label: t("col.lastActive"),
          align: "right",
          render: (row) => formatDay(locale, row.lastActiveDate),
        },
      ]}
    />
  );
}

export function LocalUsageRequestsTable({
  rows,
  total,
}: {
  rows: LocalUsageRequestRow[];
  total: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `${L}.${id}` });
  const tokens = (value: number) => formatCompactTokenUsage(locale, value);
  return (
    <div className="space-y-2">
      <LocalUsageTable
        rows={rows}
        rowKey={(row) => row.id}
        empty={t("emptyDescription")}
        columns={[
          {
            key: "time",
            label: t("col.time"),
            render: (row) => formatDateTime(locale, row.timestamp),
          },
          { key: "source", label: t("col.source"), render: (row) => t(`origin.${row.origin}`) },
          { key: "model", label: t("col.model"), render: (row) => row.modelId },
          {
            key: "project",
            label: t("col.project"),
            render: (row) => (row.cwd ? <span title={row.cwd}>{shortenCwd(row.cwd)}</span> : "--"),
            className: "max-w-[200px] truncate",
          },
          {
            key: "input",
            label: t("col.input"),
            align: "right",
            render: (row) => tokens(row.inputTokens),
          },
          {
            key: "output",
            label: t("col.output"),
            align: "right",
            render: (row) => tokens(row.outputTokens),
          },
          {
            key: "cache",
            label: `${t("col.cacheRead")} / ${t("col.cacheWrite")}`,
            align: "right",
            render: (row) => `${tokens(row.cacheReadTokens)} / ${tokens(row.cacheWriteTokens)}`,
          },
          {
            key: "cost",
            label: t("col.cost"),
            align: "right",
            render: (row) => formatCostUsd(locale, row.costUsd),
          },
        ]}
      />
      <p className="px-3 text-ui-sm text-foreground-subtle">
        {intl.formatMessage(
          { id: `${L}.requests.note` },
          {
            shown: formatCompactNumber(locale, rows.length),
            total: formatCompactNumber(locale, total),
          },
        )}
      </p>
    </div>
  );
}
