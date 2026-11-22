# usage-stats-local-ui

设置页「使用统计」本机多来源（ZCode / Claude Code / Codex）面板。规则见
[docs/usage-stats-local-sources.md](../../../../../../docs/usage-stats-local-sources.md)。

不变量：

- 只通过 `useServices().usageStatsService` 读取；RPC 结果用 `localUsageSnapshotSchema` 再校验。
- 扫描只在面板挂载期间发生：挂载即请求，之后每 30s 刷新（页面隐藏时跳过），卸载后丢弃迟到响应。
- 来源/范围/tab 为组件局部状态；ZCode 运行指标只在来源为 全部/ZCode 时渲染。
- 文案使用独立命名空间 `settings.usageStats.local.*`（`i18n.ts`），zh-CN 与 en-US 键集一致。
