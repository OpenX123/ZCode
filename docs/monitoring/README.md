# 本地诊断文档入口

状态：2026-10-24 独立桌面版本。官方 `/report`、ARMS、OTLP 导出与商业事件监控已经退役；旧专题文件仅保留退休说明，相关远端 dashboard JSON 和平台验收配置已删除。

当前可用能力：

- [本地 TTFT 计时](../trace/local-ttft-diagnostics.md)：Renderer 本地阶段观察与 debug 日志。
- [进程内存本地诊断](memory-diagnostics-log.md)：本机日志和领域计数器。
- [Session 停止来源诊断](session-stop-source-diagnostics.md)：停止按钮与 Esc 的生命周期日志。
- [资源管理器](../electron/resource-manager.md)与[网络请求观测](../electron/resource-manager-network.md)：用户打开窗口时的本地诊断。
- [工程 E2E 指标看板](e2e-metrics-bitable-dashboard.md)：显式 CI 工程任务，独立于 App 默认运行流程。

默认运行不向原厂发送诊断数据。边界与验收见[独立桌面规格](../desktop/standalone-coding-harness-spec.md)。

`local-ttft-evidence.json` 与 `local-ttft-diagnostics-evidence.json` 仅保留历史受控回放事实，不能用于声明当前构建、真实模型 API 或跨平台验收通过。
