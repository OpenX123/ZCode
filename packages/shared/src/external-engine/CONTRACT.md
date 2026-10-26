# External engine protocol

会话引擎（`zcode` / `claude-code` / `codex`）的值域、引擎配置项 schema、外部引擎运行时描述与就绪状态契约。只含 schema、常量与纯函数，不含 IO。

- 会话引擎在创建时选定、之后不可变；缺省（含旧快照）经 `resolveSessionEngine` 视为 `zcode`。
- `EXTERNAL_ENGINE_RUNTIMES` 是 adapter 包名、锁定版本、官方 CLI 与环境变量规则的唯一来源；安装、检测与启动方都从这里读取。
- `externalEngineStatusSchema.ready` 是外部引擎会话的执行门禁，失败时使用 `engine_not_ready`。

规则来源：`docs/desktop/external-agent-engines-spec.md`。

EngineConnectionFailure 是连接错误的安全投影：固定错误分类、ACP 方法、数值 rpcCode；不包含供应商原文。connecting/ready 事件清除旧错误，旧快照字段可缺省。
