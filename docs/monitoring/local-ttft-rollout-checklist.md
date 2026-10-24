# 本地 TTFT 验收记录边界

状态：2026-10-24。旧 ARMS 上线与灰度清单已退役，当前版本保留[本地计时](../trace/local-ttft-diagnostics.md)。

- 受控回放：核对同轮关联、实际首内容、排队、取消与前后台排除行为。
- 真实 API：仅在显式配置用户 Provider 后另行验证，记录模型与平台，不能从回放结果推断。
- 平台与安装包：分别记录本次执行的平台、产物和实际结果；历史 JSON 不是本次验收。
- 网络退出：默认启动、空闲与普通 coding 不产生官方诊断导出请求。

统一交付要求见[独立桌面规格](../desktop/standalone-coding-harness-spec.md)。不再要求 ARMS 账号、官方 exporter、云端 dashboard 或留存计费配置。
