# ExternalEnginePort

串行运行官方 ACP 引擎会话，保存引擎 id，按到达顺序交付更新。调用方持有 admission、transcript 和权限状态；adapter 持有进程与请求表。不访问凭据，不安装依赖，不隐式创建替代恢复会话。取消发送 session/cancel；关闭拒绝 pending 请求并终止进程树。配置必须经过引擎返回的 options。

ExternalEngineConnectionError 携带 shared 的 EngineConnectionFailure。prepareSession 可在无 prompt 副作用前有限重试并合并同会话调用；取消/关闭终止准备；runTurn 不重发已提交的 prompt。错误诊断不携带供应商原始内容。

结构化失败由 adapter 归一为 ExternalEngineFailureNotice（warning 为重试中、error 为终态）经 onFailure 交付，prompt 响应携带的 typed 终态失败放入 ExternalEngineTurnResult.failure；ACP `notice`（非致命提示，不是失败）由 adapter 脱敏为 ExternalEngineNotice 经 onNotice 交付，不进入 onUpdate，也不产生重试状态。isSessionConnected 只报告是否存在健康连接，供 Runtime 在静默重连前发布 connecting。规则见 docs/desktop/native-plan-errors-spec.md。
