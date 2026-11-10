# codeg ACP 与配置体验调研

调研日期：2026-11-09。目标仓库：<https://github.com/spacering-net/codeg>。本次读取的提交为 `39fe4cc0950e9fab65aa1a04ed85db8614ce3d53`。本文仅描述外部项目的实现与可借鉴点，不代表 ZCode 缺失这些机制，也不改变 ZCode 产品规则。

证据：浅克隆源码、README 的官方工作区截图及相关测试文件名称；未安装运行 codeg，没有测量连接耗时。源码注释中的“warm <2s”“cold 10–30s”是作者的经验说明，不能当作本次基准测试结果。

## 1. 最值得借鉴的点

| 思想                            | codeg 的实际实现                                                                                                                                                                                                                                                                                                                                                                                                     | 对 ZCode 的借鉴方式                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 检查结果直接解释下一步          | `CheckItem` 含 `check_id/label/status/message/fixes`，检查结果不是仅有一个 connected boolean。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/preflight.rs#L13-L85)                                                                                                                                                                                    | 把安装、路径、运行时、鉴权、握手结果分别表达，并为失败项提供明确操作；不要把离线检查通过写成鉴权成功。          |
| 解释“我装了 CLI 为什么还不能连” | `AdapterInfo` 区分实际启动的 ACP adapter、原生 CLI、是否需要额外 runtime、共享配置目录；它只解释，不额外阻塞通过状态。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/preflight.rs#L46-L85)                                                                                                                                                            | 在引擎详情说明启动器与底层 CLI 的关系、实际解析路径、凭据来源，减少“重复装/重复登录”的误解。                    |
| 常规检查便宜，深诊断按需        | adapter 检查仅做路径解析，不每次 `--version`；两个可能依赖 npm prefix 的查找并行。昂贵版本检查在有单命令超时的诊断报告中执行。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/preflight.rs#L219-L246)                                                                                                                                                  | 打开设置先展示已有配置和快检；诊断、完整 ACP 探测独立执行，避免设置页所有卡片一起转圈。                         |
| 成功检查折叠，异常展开          | 检查卡默认 `check.status !== pass` 时展开，直接带修复按钮；用户手动展开状态会被保留。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/acp-agent-settings.tsx#L6286-L6340)                                                                                                                                                                         | 常态压缩，失败时给出“原因 + 操作 + 详情”，把关键问题提升到首屏。                                                |
| 让用户知道保存何时生效          | 设置保存后比较启动时与当前有效配置指纹，通知旧会话；会话内 banner 提供“重连以应用”，运行中禁用，并仅让 owner 操作。[后端](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L1061-L1107) · [界面](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/chat/session-config-stale-banner.tsx#L19-L104) | 显示“已保存 / 对新会话生效 / 此会话仍用旧配置”，由产品规则决定继续旧绑定或显式新建，不能擅自替换历史 engineId。 |
| 稳定状态低显著，异常可行动      | composer 状态常态是低显著图标，点击展开 agent/cwd/session/error 与重连；pending 与失败单独保存，即使尚未创建连接 entry 也能显示。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/chat/composer-connection-status.tsx#L29-L218)                                                                                                                            | 借鉴渐进披露，同时增加文字和阶段信息，不能只照抄心形图标或只依赖颜色。                                          |
| 会话配置形成一个稳定入口        | 合并 chip 汇总 model/effort/mode，一个 popover 内就地修改；按 ACP config options 转换为列表、分段或开关，模型多时搜索。[控件](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/chat/session-settings-picker.tsx#L35-L204) · [归一化](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/lib/session-settings.ts#L9-L175)    | 模型、思考强度和权限模式保持语义独立，只在视觉层合并；实际可选项由运行时能力确认。                              |

## 2. 连接、复用与资源生命周期

### 2.1 恢复同一会话的去重是原子操作

`SpawnDedupKey` 为 `(agent_type, working_dir: Option<PathBuf>, session_id)`。对已有 session 的并发 connect，把“查现有连接 → spawn → 等 SessionStarted”置于同一个 per-key async mutex 内，避免握手尚未填充 external_id 时重复 spawn。新会话 `session_id = None` 明确不做这种去重。

来源：[key](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L283-L299)、[临界区](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L797-L909)、[复用判断](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L1110-L1160)。cwd 使用 PathBuf 等值判断，规范化由调用者负责，manager 不保证自动 canonicalization。

不能得出的结论：codeg 有通用 ACP 进程池、任意新会话共用一个进程、跨设备同路径应共享连接。ZCode 已有 single-flight 与会话连接复用，需要对照其真实边界改进，不能再建一层竞争 owner。

### 2.2 安装准备与握手分开

- Binary 按 agent/version 查询缓存，命中直接复用；下载时输出阶段进度，custom registry 可携带 SHA-256，在解包前校验。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/binary_cache.rs#L791-L823) · [校验](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/binary_cache.rs#L941-L1005)
- `prewarm_uvx_agent` 在安装流程运行固定 package 的 `--version`，预取 uvx 包缓存，把首次下载费用前移；不是长期保活的 ACP connection pool。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/commands/acp.rs#L362-L420)
- `initialize` 带取消信号、60 秒超时和 elapsed 日志，协议错误附稳定 error code 供 UI 本地化。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/connection.rs#L9072-L9138)。60 秒是失败上界，不能作为“优化速度”的建议。

可借鉴的是把“安装中、启动中、协议握手中、加载会话中”拆开并测量。未完成真实本地/SSH 基准前，不能宣称某个阶段就是用户的耗时根因。

### 2.3 探测有独立预算

`probe_agent_options` 对每个 agent 序列化，创建临时 session，等待 selectors ready，始终 disconnect 清理；超时与成功但无选项区分。它仍会启动真实 CLI，不能认为零成本。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L2775-L2900)

委派默认值面板有 250ms UI debounce、30 秒 `(agent, model)` 缓存与 request id 防旧响应覆盖；这些是该面板的局部策略，不是全项目统一缓存协议。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/delegation-agent-defaults.tsx#L50-L197)

对 ZCode 更合理的对应是状态/能力快照优先、显式刷新完整探测、取消不再需要的探测，并把配置 revision、执行端 identity 纳入失效规则；不能照抄仅 `(agent, model)` 的缓存 key。

### 2.4 释放遵守活动事实

idle sweep 默认 180 秒、每 60 秒运行；前端可见标签约 30 秒 touch。manager 保护 prompting、权限等待、后台工作和委派链等状态。它是泄漏回收机制，不代表建议把 ZCode 的既有保活阈值改为 3 分钟。[sweep](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/idle_sweep.rs#L1-L60) · [活动判断](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L989-L1056)

恢复路径按能力和错误分类，支持 session/resume、session/load，也包含 load→new 的兼容分支；特定不可恢复/鉴权失败不会盲目继续新会话。[实现](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/connection.rs#L9396-L9518) · [分类与 fallback](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/connection.rs#L9803-L9898)。ZCode 必须保留自身不静默丢失历史的恢复合同，不能直接复制此策略。

## 3. 配置结构与生效解释

codeg 分开存储：

| 对象           | 实际字段                                                                                           | 来源                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent_setting  | agent_type、registry_id、enabled、sort_order、installed_version、env_json、model_provider_id       | [entity](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/db/entities/agent_setting.rs#L3-L18)  |
| model_provider | name、api_url、api_key、agent_type、model 等                                                       | [entity](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/db/entities/model_provider.rs#L3-L18) |
| custom_agent   | registry_id、distribution_kind/spec_json、source、version_probe、supports_mcp、skills declarations | [entity](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/db/entities/custom_agent.rs#L3-L38)   |

它明确区分“引擎安装定义”“运行环境 overlay”“模型提供方”“会话选项”；但表里存在 api_key 明文字段，本次未审计其存储加密，不建议借此替换 ZCode 现有凭据保管路径。

对话配置 staleness 指纹由 effective runtime_env（去掉每次运行变化的 key）和原生配置文件内容等组成。digest 留后端进程内，前端仅收到 stale boolean。保存后报告受影响会话数；没有变化的保存保持安静，恢复启动时配置会清除 stale。[指纹](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/commands/acp.rs#L11968-L12087) · [通知](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src-tauri/src/acp/manager.rs#L1061-L1107)

这解决“保存了为什么当前会话没变化”，但不能证明它有全局统一的配置来源/冲突解释器。部分引擎同时写 DB env 与原生配置，前端专门串行以避开竞争；例如 Codex 保存先 env 后完整 config。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/acp-agent-settings.tsx#L8422-L8465)。因此应借鉴用户反馈，而不是复制多路径写入。

## 4. UI/UX 的可复用设计

1. **设置用主从布局。** 左边 agent 列表可排序，显示启用、可用状态、单项重查；右边详情统一显示名字、distribution、ACP adapter/custom badge、enable 开关，再展示分项检查与诊断入口。[布局与列表](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/acp-agent-settings.tsx#L8568-L8713) · [详情](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/acp-agent-settings.tsx#L8715-L8852)
2. **自定义添加给两个层次。** Registry 选择与手工 distribution spec 分开；可接受整个 registry entry 或 distribution，提供按实际平台生成的 npx/uvx/binary 模板。编辑 registry id 锁定，避免会话引用失效。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/add-custom-agent-dialog.tsx#L57-L166)
3. **诊断给结论，保留证据。** 诊断 dialog 有本地化 verdict、分项严重性、再次执行、复制纯文本报告；区分 adapter_missing_native_present、terminal_only_path、npm_prefix_timeout 等具体情形。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/settings/agent-diagnostics-dialog.tsx#L72-L157)
4. **草稿选择不被连接过程锁死。** Agent selector 的 disabled 明确用于已绑定 conversation；草稿在启动中仍可选择，选中项始终可见，超出宽度进入 more popover。自动 fallback 与主动选择分开回调。[源码](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/chat/agent-selector.tsx#L43-L166)
5. **会话选项按能力显示。** 不固定为每个引擎硬塞相同字段；少量选项分段、多量带搜索、布尔开关，未知/default 不谎称 off。统一 popover 无嵌套浮层，窄容器收起摘要，触屏打开不会立刻触发搜索框软键盘。[选项模型](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/lib/session-settings.ts#L12-L175) · [交互](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/src/components/chat/session-settings-picker.tsx#L49-L203)

已查看官方 [workspace-light.png](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/docs/images/workspace-light.png)：截图体现左侧会话导航、中间任务与输入区、右侧工程内容，并列出 agent 图标选择与输入框内模式/模型控件。截图是仓库宣传资产，控件可能早于当前代码；本节细节优先以对应源码为准，不声称观察过实际运行 UI。

## 5. 不直接照搬的部分与限制

- **不直接搬大文件。** 当前 `acp-agent-settings.tsx` 超过 13k 行，`acp/connection.rs` 更大；可学统一表面与能力归一化，ZCode 应按其现有模块和状态所有者分解。
- **不复制多来源写入机制。** 原生 CLI 文件与 DB env 的协调已有专门防竞态逻辑；ZCode 应提供单一 commit 服务和有效配置解释，再决定是否需要外部配置导入。
- **不推断真实速度。** 已读源码有缓存、取消、single-flight，但没有对同一机器/Agent/网络测到的对照数据，也没运行上游测试。上游超时、缓存 TTL 不能直接成为 ZCode 参数。
- **不扩大产品范围。** codeg 的移动端、自托管、消息渠道、无限画布等超出本次 ACP 连接与配置优化；不因此恢复 ZCode 已退役入口。
- **不复制身份 key。** codeg 的 cwd/session tuple 不能替代 ZCode 的 workspaceIdentity、remoteSessionId、Host owner/lease 与跨 Host 路由隔离。
- **不把思路来源写成缺失清单。** ZCode 已有 single-flight、会话连接复用、草稿 prewarm、状态缓存、engineId 绑定隔离、凭据保管；本次应基于其实际实现补齐诊断和生效反馈。

许可证为 [Apache-2.0](https://github.com/spacering-net/codeg/blob/39fe4cc0950e9fab65aa1a04ed85db8614ce3d53/LICENSE)。如后续直接复制代码，再按实际复制范围保留版权/许可与修改声明；本方案只借鉴结构与交互思想。
