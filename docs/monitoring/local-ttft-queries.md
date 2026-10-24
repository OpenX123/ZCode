# 本地 TTFT 查询与验收

状态：2026-10-24 已改为纯本地诊断。当前合同见[本地 TTFT 计时](../trace/local-ttft-diagnostics.md)。旧 ARMS 查询、Grafana dashboard 与默认 OTLP 接入配置已删除。

使用明确的开发诊断运行，读取 UI logger debug 输出。按同一 workspace、command、session 与观测 ID 关联点击、派发和实际首内容；admission ACK 不作为首 Token。排队、确认、取消和前后台排除项必须分别报告，不能记作成功 TTFT。

`local-ttft-evidence.json` 和 `local-ttft-diagnostics-evidence.json` 是 2026-09 的历史受控回放，既不是当前构建验证，也不是真实 API 延迟结果。当前独立构建的检查结果应写入[独立桌面规格](../desktop/standalone-coding-harness-spec.md)的验证记录。
