import type { LocalUsageRange } from "@zcode/shared";

export type LocalUsageTrendMetric = "tokens" | "requests" | "cost";

/** 费用展示：USD；极小但非 0 的值显示为 <$0.01，避免被四舍五入成 $0.00。 */
export function formatCostUsd(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  if (value > 0 && value < 0.01) {
    return `<${new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(0.01)}`;
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

/** 单价展示（USD / 百万 token），保留到 4 位小数以容纳 0.0025 之类的缓存价。 */
export function formatUnitPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  return `$${Number(value.toFixed(4))}`;
}

/** 项目列显示 cwd 的最后两段，完整路径放在 title。 */
export function shortenCwd(cwd: string): string {
  const segments = cwd.split(/[\\/]+/u).filter(Boolean);
  return segments.length <= 2 ? cwd : `…/${segments.slice(-2).join("/")}`;
}

/** ZCode 运行指标沿用 agent-db 的 7d/30d/all 窗口；今天并入 7d，自定义并入全部。 */
export function mapToAppUsageRange(range: LocalUsageRange): "7d" | "30d" | "all" {
  if (range === "today" || range === "7d") return "7d";
  if (range === "30d") return "30d";
  return "all";
}

export function formatDateTime(locale: string, timestamp: number): string {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** 解析价格输入；空串视为 undefined（可选的 1h 价格），非法返回 null。 */
export function parsePriceInput(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
