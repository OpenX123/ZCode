# ExternalEnginePort

串行运行官方 ACP 引擎会话，保存引擎 id，按到达顺序交付更新。调用方持有 admission、transcript 和权限状态；adapter 持有进程与请求表。不访问凭据，不安装依赖，不隐式创建替代恢复会话。取消发送 session/cancel；关闭拒绝 pending 请求并终止进程树。配置必须经过引擎返回的 options。

ExternalEngineConnectionError 携带 shared 的 EngineConnectionFailure。prepareSession 可在无 prompt 副作用前有限重试并合并同会话调用；取消/关闭终止准备；runTurn 不重发已提交的 prompt。错误诊断不携带供应商原始内容。
