# 本地 TTFT 计时

状态：2026-10-24 独立桌面版本。保留本地发送阶段计时，删除官方 OTLP / ARMS 导出。

`packages/desktop/src/renderer/src/localTtftBootstrap.ts` 在桌面创建既有 `LocalTtftObserver`，采样时钟并跟踪窗口前后台；卸载时中断未闭合观测、清理定时器和事件监听。Observer 默认把记录交给 UI logger 的 debug 通道，不调用 IPC 上报或网络导出。

Renderer 拥有点击总时钟，CLI / Host 的既有帧提供运行阶段事实。首输出依据实际内容帧，不能把 admission ACK 当作首 Token。工作区、command、session 和观测标识必须匹配，迟到或不匹配的结果不能归入另一轮发送。

排队、用户确认、前后台切换、失败、取消、容量限制及无法完成的观测分别保留其状态；排除记录不得伪装为成功 TTFT。计时的采样、合并或记录失败不影响真实请求和内容投影。

生产 debug 不落盘，因此缺少记录不等于发送没有发生；需要阶段细节时使用明确的开发诊断运行。此计时与[本地 Usage](../../apps/zcode-cli/docs/design/v2/usage-observability.md)用途不同，均不恢复官方遥测或计费服务。
