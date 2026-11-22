# usage-stats-local

Host 侧本机用量：Claude Code / Codex 日志增量扫描、ZCode 原生事实缓存、价格表与聚合。
规则见 [docs/usage-stats-local-sources.md](../../../../../docs/usage-stats-local-sources.md)。

不变量：

- `LocalUsageScanner` 是日志游标与解析结果的唯一所有者；只由 `getLocalUsageSnapshot` 驱动，单飞执行，
  5 秒内复用上次索引，没有后台定时扫描。
- 增量读取只推进到最后一个完整行；截断或改写（尾部指纹不一致）时全量重扫该文件。
- Claude 按 `message.id`(+`requestId`) 跨文件去重，Codex 按 `timestamp + total` 签名跨文件去重。
- 缓存与价格文件位于 `~/.zcode/v2/usage-stats/`，原子写；缓存损坏时丢弃并重扫。
- `ModelPricingStore.syncFromModelsDev` 是唯一联网入口，只由用户点击触发。
- `aggregateLocalUsage` 是纯函数，不做 IO。
