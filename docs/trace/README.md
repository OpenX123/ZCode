# 本地运行诊断

当前目录只描述独立 coding harness 保留的本地诊断能力。官方 CLI / Renderer Telemetry、OTel / ARMS 导出、身份绑定及其运维规范已退役；历史文档中的上报字段和查询不代表当前实现。

| 文档                                                                         | 当前范围                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| [对话错误展示与本地排查](chat-error-banner-attribution.md)                   | 保留错误详情、复制、模型设置及 SSH 重连；不上传反馈或遥测 |
| [模型失败的因果链](model-attempt-error-diagnostics.md)                       | 错误包装保留真实 cause，辅助本地排查；不创建或导出 span   |
| [本地 TTFT 计时](local-ttft-diagnostics.md)                                  | 点击到实际首输出的本地 debug 观测，保持运行链路与观测分离 |
| [CLI 本地 Usage](../../apps/zcode-cli/docs/design/v2/usage-observability.md) | 本地模型、Token、工具与会话统计                           |
| [CLI 本地 Debug](../../apps/zcode-cli/docs/design/v2/debug-observability.md) | 开发期结构化日志、会话与显式诊断数据                      |
| [进程内存诊断](../monitoring/memory-diagnostics-log.md)                      | 本机进程内存采样与日志                                    |
| [停止来源诊断](../monitoring/session-stop-source-diagnostics.md)             | 区分停止命令来源与最终执行事实                            |

CLI 持有会话正文与执行事实，Host 持有组织态和路由，Renderer 只展示投影。日志和计时是派生证据，不能代替命令 ACK、Registry 可执行性或会话终态，也不能参与模型重试、权限审批或状态裁决。

产品边界及验收以[独立桌面规格](../desktop/standalone-coding-harness-spec.md)为准。本地回放、真实 API 和安装包验证须分别记录。
