# ZCode 当前领域与交叉边界

先用 `zcode-feature-graph.yaml` 定位语义，再核对当前源码和规格。本分支的产品边界以 `docs/desktop/standalone-coding-harness-spec.md` 为准；历史商业、云分享和手机官方远控文档只用于理解兼容数据，不作为当前入口。

## 使用顺序

1. 匹配能力及界面，区分展示、候选来源、草稿默认、校验、提交、持久化和恢复。
2. 从下表选择相关领域，读取当前规格与代码种子。
3. 对已索引实现先用 CodeGraph 查直接调用者和提交路径，再用 `rg` 查文档、配置或未索引内容。
4. 明确 Renderer 草稿、Host 服务、CLI 运行时、存储和 SSH 目标的所有者。
5. 只展开影响行为的维度，用不变量合并组合；深度默认 2，关键所有者未明时再用 3。

## 领域入口

| 领域            | 关键维度                                                                  | 文档与代码种子                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架构与进程      | Renderer/Main/Host/CLI 所有者，本地与 SSH，stdio/RPC                      | `docs/architecture/zcode-code-architecture-overview.md`、`packages/services/src/node.ts`、`packages/desktop/src/host`                                                |
| 会话与任务      | phase、queue、stop、compact、goal、fork、edit、stream                     | `docs/conversation-protocol-declaration.md`、`docs/conversation-product-state-space.md`、`packages/ui/src/store/zcodeSessionStore*`、`packages/services/src/session` |
| 跨界面模型选择  | 候选与默认、当前任务与草稿、校验和提交边界                                | `docs/feature-impact-discovery.md`、`ModelConfigSelect`、`buildModelSelectGroups`、`V4ComposerToolbar`、`AutomationEditView`、`SubagentsSection`                     |
| Provider 与配置 | 普通 API Key、Personal/Built-in、Registry、默认模型、推理选项、冻结 Model | `docs/desktop/standalone-coding-harness-spec.md`、`packages/services/src/model-provider`、`packages/ui/src/hooks/useModelProviders.ts`                               |
| SSH 配置分发    | Personal 唯一来源、目标 Registry、幂等与 CAS/回滚、重连 session id        | `docs/remote/provider-provisioning.md`、`ProviderProvisioningEnvironmentCoordinator`、`createProviderProvisioningSource`、`createProviderProvisioningTarget`         |
| 工作区隔离      | workspaceIdentity/path、remoteSessionId、owner/lease、stale run           | `docs/remote-workspace-session-unified-settings.md`、`docs/ssh-remote-app-global-state-authority.md`、`packages/shared/src/remoteTarget.ts`                          |
| 持久化与迁移    | 正文与索引、快照、设置、localStorage、旧记录兼容                          | `docs/task/task-sqlite-index.md`、`docs/task/task-snapshot-on-demand.md`、`taskIndexRepo`、`legacyTaskSessionFile`                                                   |
| 渲染性能        | 流式输入、后台任务、delta、解析预算、本地日志量                           | `docs/chat/message-render-performance.md`、`docs/performance/streaming-tool-input-backpressure.md`、`packages/ui/src/lib/zcodeSessionProjection.ts`                  |
| 本地用量与诊断  | token/latency/tool 事实、时间范围、日志和资源，不代表供应商账单           | `docs/product-capability-map.md`、`packages/services/src/usage-stats`、`packages/ui/src/settings/usage-stats`、`packages/services/src/logger/serviceLogger.ts`       |
| 权限与扩展      | permission、elicitation、工具生命周期、MCP OAuth、Subagent 继承           | `docs/permission-project-approval.md`、`docs/mcp-platform-boundary.md`、`packages/shared/src/zcode-protocol`、`packages/ui/src/ToolCallBlocks`                       |
| 自动化与工作流  | 本地计划、cron、状态、历史、默认 onDemand、用户选择                       | `docs/desktop/standalone-coding-harness-spec.md`、`packages/ui/src/settings/AutomationsSection.tsx`、`packages/shared/src/dynamic-workflow-feature.ts`               |
| UI 壳与主题     | 桌面/窄屏 Web、locale、主题、Settings、键盘行为                           | `DESIGN.md`、`packages/ui/src/i18n`、`packages/ui/src/useTheme.ts`、`packages/ui/src/SettingsPage.tsx`                                                               |
| 平台与工作台    | 本地/远端文件、PTY、Git、浏览器、进程生命周期                             | `packages/desktop/src/main`、`packages/ui/src/workspace-file-tree`、`packages/ui/src/terminal`、`packages/services/src/git`                                          |

## 状态权威

| 状态             | 权威                            | 可读镜像                       |
| ---------------- | ------------------------------- | ------------------------------ |
| 会话正文与运行态 | CLI runtime/session store       | UI projection 与 Host 转发快照 |
| 已接受的排队输入 | CLI CommandInbox 串行 admission | UI pending optimistic overlay  |
| 未提交输入       | Renderer 草稿                   | 本地草稿持久化                 |
| 任务元数据       | Host tasks-index.sqlite         | UI 任务列表缓存                |
| 模型执行         | 目标环境 Registry 创建的 Model  | UI 选择与默认值                |
| SSH Provider     | 目标 Personal 配置与 Registry   | Host/Worker 各自 Registry 实例 |
| 本地用量         | CLI Usage DB                    | Host bridge 与 UI 统计投影     |
| 主题与语言       | Renderer 本地偏好和跨窗口广播   | DOM 与 Settings 展示           |

## 需要验证的交叉场景

- 当前任务切模型、发送、Registry 刷新：下一次请求实际使用哪个模型？已有 Model 是否保持冻结？
- SSH 重连与 Personal 分发：新 remoteSessionId 是否使用正确目标配置，失败是否保留已恢复工作区？
- 排队输入与 stop/edit/fork/compact：未来输入是否保留，是否错误重排或自动提交？
- 设置变更与工作流：Host 同步和 UI 重读是否串行，用户选择是否立即覆盖默认值？
- 旧任务与失效套餐模型：原选择是否保持，是否明确要求配置普通 Provider？
- 大工具输入与流式 UI：正文、摘要及最终结果是否有明确预算？
- 本地用量与日志：统计事实来源是否正确，日志是否泄露 API Key？
- 第三方 MCP OAuth 与普通模型 API：分别处理凭据，不重新接入官方产品登录或权益。

## 不变量

- Main 只负责平台、调度和路由，CLI 拥有会话、队列与执行事实。
- `workspacePath` 用于执行和展示，`workspaceIdentity?.trim() || workspacePath` 用于隔离。
- tasks-index.sqlite 不拥有正文和活动运行配置。
- 已接受输入由同一 CommandInbox 接纳；UI 只拥有草稿和乐观投影。
- 历史兼容读取不恢复官方登录、套餐、遥测、云分享或手机远控入口。
- UI 通过 hooks/services/platform injection 访问能力，跨包使用公开入口。
