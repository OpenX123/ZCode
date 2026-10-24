# 官方 CLI Agent Telemetry 已退役

2026-10-24 独立桌面版本已删除 CLI Telemetry 包、OTel / ARMS 导出、Renderer 用户操作 Trace、身份绑定、官方上报端点和相关装配。本文件仅保留历史链接的退休说明，不提供配置、接入或运维入口。

不再使用旧 telemetry schema、采样设置、OTLP 环境变量、ARMS 查询或 Dashboard 作为当前产品合同。旧官方凭据及历史数据不会因此被读取或删除。

保留的本地日志、错误展示、TTFT 计时和 App Usage 见[本地诊断入口](README.md)；产品边界见[独立桌面规格](../desktop/standalone-coding-harness-spec.md)。
