# External engine protocol

本机 `ExternalEngineConnectionConfigPreferences` 为 engine → connectionProfileId → configId，沿用仅 model/effort 校验。AppSettings 保留 legacy engine 偏好兼容读取，新确认只写连接偏好；SettingService 在同一写队列内逐 engine/profile/configId 合并增量，不覆盖其他连接。

会话引擎（`zcode` / `claude-code` / `codex`）的值域、引擎配置项 schema、外部引擎运行时描述与就绪状态契约。domain 层只含 schema、常量与纯函数；Node-only 的 `node/cli.ts` 供 Host 与 adapter 共用 PATH/PATHEXT 解析，不从浏览器入口导出。

- 会话引擎在创建时选定、之后不可变；缺省（含旧快照）经 `resolveSessionEngine` 视为 `zcode`。
- `EXTERNAL_ENGINE_RUNTIMES` 是 adapter 包名、锁定版本、官方 CLI 与环境变量规则的唯一来源；安装、检测与启动方都从这里读取。
- `externalEngineStatusSchema.ready` 是外部引擎会话的执行门禁，失败时使用 `engine_not_ready`。
- `engineConfigOptionKind` 是原生配置类别的唯一判定（`model`、思考深度 `effort`、其余 `other`）；深度选择器与按引擎记忆共用，`ExternalEngineConfigPreferences` 只保存 model 与深度。
- `node/cli.ts` 解析 Windows npm/pnpm 包装入口的目标：Claude 指向 `.exe` 或 JS 时使用该文件，Codex 的官方 `codex.js` 解析为平台包内原生 `codex.exe`（找不到时保留 `.cmd`）；Host 检测与 adapter 连接共用同一结果。

规则来源：`docs/desktop/external-agent-engines-spec.md`。

EngineConnectionFailure 是连接错误的安全投影：固定错误分类、ACP 方法、数值 rpcCode；不包含供应商原文。connecting/ready 事件清除旧错误，旧快照字段可缺省。

2026-11-07：`connection.ts` 是连接配置的唯一契约：配置 / 文件 / 视图 schema、写入命令、测试结果，以及纯函数（内置配置、绑定解析、网关域名、`buildEngineConnectionEnv` 环境规则）。Host 诊断/登录与 CLI 启动 adapter 共用这些函数，不另写剔除列表；函数不读写文件或凭据，密钥只作为参数进入 Claude API Key 环境。

2026-11-09 ACP 管理页：结构化检查为可选安全投影，认证/路由按 connectionProfileId 隔离，ready 仅为运行环境可用。配置先读、所选引擎独立诊断；查看不写上次使用，编辑 Dialog 沿用新 ID 保存与旧绑定。管理检查/安装支持按引擎取消，登录/测试沿用既有取消；详见 external-agent-engines-spec.md「设置诊断接口与取消边界」。

备用许可的跨进程契约位于 shared `zcode-protocol/index.ts`：strict acquire/release/revoke 仅 requestId（acquire 结果可含 leaseId），prepare 仅 engine/profile。窗口 Host 以真实 client 绑定许可，generation 与凭据只在 adapter 内部，环境 capability 不代表授权。
