# usage-stats-local-protocol

本机多来源用量（ZCode 原生 / Claude Code / Codex 日志）跨 RPC 的请求、快照与价格 schema。
产品规则与所有者见 [docs/usage-stats-local-sources.md](../../../../docs/usage-stats-local-sources.md)。

不变量：

- Host（`IUsageStatsService`）返回前、Renderer 收到后都用这里的 zod schema 校验；请求是 strict，未知字段拒绝。
- 快照只描述 Host 所在机器的数据，不含远程工作区所在机器的日志。
- 金额单位 USD，单价单位 USD / 百万 token；`costUsd: null` 表示未定价，不能当作 0。
- `heatmapWeeks` 与 `AppUsageHeatmapWeek` 同形，`turnCount` 承载请求数。
- 模块自包含（`requires: []`），由 `packages/shared/src/index.ts` 再导出。
