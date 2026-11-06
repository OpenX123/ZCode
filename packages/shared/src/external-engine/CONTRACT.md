# External engine protocol

会话引擎（`zcode` / `claude-code` / `codex`）的值域、引擎配置项 schema、外部引擎运行时描述与就绪状态契约。domain 层只含 schema、常量与纯函数；Node-only 的 `node/cli.ts` 供 Host 与 adapter 共用 PATH/PATHEXT 解析，不从浏览器入口导出。

- 会话引擎在创建时选定、之后不可变；缺省（含旧快照）经 `resolveSessionEngine` 视为 `zcode`。
- `EXTERNAL_ENGINE_RUNTIMES` 是 adapter 包名、锁定版本、官方 CLI 与环境变量规则的唯一来源；安装、检测与启动方都从这里读取。
- `externalEngineStatusSchema.ready` 是外部引擎会话的执行门禁，失败时使用 `engine_not_ready`。

规则来源：`docs/desktop/external-agent-engines-spec.md`。

EngineConnectionFailure 是连接错误的安全投影：固定错误分类、ACP 方法、数值 rpcCode；不包含供应商原文。connecting/ready 事件清除旧错误，旧快照字段可缺省。

2026-11-07：`connection.ts` 是连接配置的唯一契约：配置 / 文件 / 视图 schema、写入命令、测试结果，以及纯函数（内置配置、绑定解析、网关域名、`buildEngineConnectionEnv` 环境规则）。Host 诊断/登录与 CLI 启动 adapter 共用这些函数，不另写剔除列表；函数不读写文件或凭据，密钥只作为参数进入 Claude API Key 环境。
