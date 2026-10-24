# 阅读本地 TTFT 诊断

当前实现见[本地 TTFT 计时](../trace/local-ttft-diagnostics.md)。旧服务端 Trace Explorer 与 dashboard 已退役。

1. 先按 workspace、command、session 与观测 ID 确认同一轮发送，避免串用迟到帧。
2. 对齐 Renderer 点击时钟与 Host / CLI 已有阶段事实，检查是否经过排队或用户确认。
3. 用实际内容帧确认首输出；工具状态、ACK 和仅 reasoning 的中间状态不能凭名称替代产品首输出合同。
4. 取消、失败、后台窗口与未闭合观测应保留原结论，不能补造成功耗时。

生产 debug 默认不落盘，缺少记录不能证明发送没有发生。诊断日志不包含提示词、文件内容或凭据，也不会恢复官方网络导出。
