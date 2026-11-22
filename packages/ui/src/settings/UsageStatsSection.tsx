import { LocalUsagePanel } from "@/settings/usage-stats/local/index.js";

/** 使用统计：本机 ZCode / Claude Code / Codex 多来源用量（docs/usage-stats-local-sources.md）。 */
export function UsageStatsSection() {
  return <LocalUsagePanel />;
}
