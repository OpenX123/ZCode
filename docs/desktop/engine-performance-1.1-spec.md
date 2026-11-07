# YCode 1.1 引擎性能规格

日期：2026-11-07。决策来源：[YCode 1.1 更新方案](./ycode-1.1-plan.md)「性能（问题 1）」与附录 B，本文只写已拍板规则的落地细则、状态所有者与事件顺序，不重新讨论决策。

本文按工作流分节：§1–§6 为 CLI（内置引擎：MCP、内置插件摘要、传输分道、git 快照、性能事件），其后为 Host 发送路径、Renderer 发送路径、启动恢复、本地性能摘要与 Windows 工作区路径大小写。外部引擎 `createSession` / 握手、预热备用与闲置连接见 [外部引擎规范](./external-agent-engines-spec.md)。

## 证据（Windows 1.0.5 生产日志）

| 链路                                                                            | 实测                                     | 根因                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MCP 启动（首个模型请求前）                                                      | p50 2.5s，p90 4.5s，最大 7.4s            | `initializeMcp` 等待全部 server 连接；4 个默认启用的 office 插件各自以 Node 模式启动 YCode.exe 并加载 14.5MB bundle |
| 会话 app 插件阶段                                                               | p50 0.8s，p90 1.4s                       | 每次建 app 都同步重读并 SHA-256 约 42MB / 600 个内置插件文件                                                        |
| `rowsRange` / `plans` / `subscribeConversationV4` / `readWorkspacePresentation` | p50 4.4s / p90 10.6s / p90 13s / p90 18s | 一个 CLI 服务整个 workspace，除少数旁路外所有请求走同一条严格 FIFO                                                  |
| 首轮上下文初始化                                                                | p50 0.25s，p90 0.74s                     | 每个 runtime 启动 5–8 个 git.exe                                                                                    |

## 1. MCP 不阻塞首个模型请求

### 规则

- 首个模型请求不等待任何 MCP 连接。会话启动只做"登记 + 读缓存"，不等待进程启动、握手或 `tools/list`。
- CLI 按 server 的**解析后配置指纹**持久化上次成功的 `tools/list` 结果（工具清单缓存）。
  - 指纹输入：应用版本、server 名、transport、stdio 的 command / args / cwd、http/sse 的 URL（只取 origin + path）与 header **键名**、OAuth 类型、`timeoutMs` / `alwaysLoad` / `protocolVersion` / `isolation`、env **键名**，以及插件身份（`ZCODE_PLUGIN_ID`）与插件根目录（含版本目录）。
  - env、header、OAuth 的**值**一律不进入指纹或缓存文件；缓存文件只含指纹、server 名、保存时间与工具描述（名称、描述、schema、注解、UI 元数据）。
  - 位置：`<CLI 数据目录>/mcp/tool-manifests/<指纹>.json`，原子写入（临时文件 + rename），读写均为异步 IO；条目数有上限，超出按修改时间淘汰最旧的文件。
- 有缓存的 server：按缓存注册工具，**不启动进程**；第一次实际使用（工具调用、资源读取、MCP App 连接）时才连接，等待沿用现有连接超时（`timeoutMs`，缺省 30s；OAuth 等待沿用会话的 15s 预算），连上后再执行调用。
- 无缓存的 server：后台连接，不阻塞首个请求；连上后其工具从**下一次模型步骤**加入。
- 任一 server 连上后都用真实 `tools/list` 刷新缓存；与缓存不一致时以真实清单为准，registry 从下一次模型步骤起使用真实清单（签名覆盖完整描述，包括 inputSchema）。
- 首次调用时启动失败：返回结构化工具错误给模型并记 warn 日志，删除该指纹的缓存；不挂起轮次。失败后该 server 的工具从下一次模型步骤起移出 registry（与原先启动失败不注册工具一致）。
- 保持会话隔离与既有 lease / close 语义：工具清单缓存只决定"何时连接"，连接仍由会话自己的 lease 创建与释放。会话关闭时正在进行的首次连接立即让等待方以错误返回，连接本身沿原有空闲回收；lease 关闭后不再创建新连接。
- 闲置回收（本机 1.0.5 实测 61 个 `YCode.exe … __zcode-plugin-host` 进程、约 4.0GB RSS，部分运行 3 天：常驻会话的每会话 MCP / 插件宿主从不退出）：
  - 会话 lease 内已连接的 server 在没有在途请求（工具调用、资源读取与订阅）且 10 分钟没有使用后，由该 lease 释放连接（经既有 30s 空闲回收关闭进程），回到"待首次使用"。
  - 工具沿用回收时的真实清单（同时刷新缓存），registry 不变；下一次调用经同一首次启动路径重新连接。
  - 不回收：有在途调用的 server；有 MCP App 页面连接（lease 上登记了连接失效监听）的 server。窗口到期时再确认，条件不满足则重新计时。
  - 有状态 server 永不闲置回收：持有跨调用进程内状态的 server 由**声明**豁免，不按 server 名特判。官方单元在 `bootstrap/src/app/official-plugin-definitions.ts` 声明 `statefulMcpServers: true`（当前为 `node-repl-host`，其 node_repl 保留 REPL 变量），宿主据此在 server 配置上写入 `idleReclaim: false`（仅限宿主生成，公共配置 schema 拒绝该字段）；lease 的闲置策略读取该配置，对它从不计闲置窗口。首次使用时启动照常适用。
  - 只适用于会话 lease；设置页（`mcp/list`）的 lease 不回收，避免状态轮询把被回收的 server 显示成断开。
  - 计时器由 lease 持有并 unref；server 被释放或 lease 关闭时清除，会话关闭后不遗留。
- 不实现非阻塞启动的端口（TUI / headless 直连 adapter、测试替身、子智能体借用端口）保持原有"启动时连接全部 server"语义。

### 状态所有者

| 状态                                 | 唯一所有者                                                                                            | 其他层                                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接                                 | 会话 MCP lease（`adapters/src/mcp/pool.ts`）                                                          | runtime 只调用 `startConfiguredServers` / `callTool`                                                                                                        |
| "待首次使用"登记、闲置计时与在途计数 | lease 持有的 server 生命周期对象（managed 模块 `cli-mcp-lazy-start`，`adapters/src/mcp/lazy-start/`） | 回收条件由 lease 再确认，回收动作复用 release + 待首次使用登记；是否可回收来自 server 配置的 `idleReclaim` 声明（官方定义 `statefulMcpServers` 经宿主写入） |
| 工具清单缓存文件                     | `cli-mcp-lazy-start` 的 `tool-manifest-cache.ts`                                                      | lease 在连接完成时写入，在登记时读取                                                                                                                        |
| registry 中的 MCP 工具               | runtime（`core/src/runtime/methods/mcp.ts`）                                                          | 只在模型步骤边界按 `toolListRevision` 刷新                                                                                                                  |

### 事件顺序

```mermaid
sequenceDiagram
  participant RT as Runtime（core）
  participant L as 会话 MCP lease
  participant C as 工具清单缓存
  participant S as MCP server 进程
  RT->>L: startConfiguredServers(servers)
  L->>C: 读取各 server 指纹的清单
  C-->>L: 命中 A / 未命中 B
  L-->>RT: 快照（A 的缓存工具，B 尚无工具，toolListRevision=r0）
  RT->>RT: 注册 A 的工具，发出首个模型请求（不等待 MCP）
  L->>S: 后台连接 B
  S-->>L: B 连接成功 + tools/list
  L->>C: 写入 B 的清单
  L->>L: toolListRevision 递增
  RT->>L: 下一模型步骤前比较 revision → listTools
  RT->>RT: 加入 B 的工具
  RT->>L: callTool(A.x)（模型调用 A 的工具）
  L->>S: 首次使用时连接 A（现有超时）
  S-->>L: A 连接成功 + 真实 tools/list
  L->>C: 刷新 A 的清单；与缓存不同则 revision 递增
  L-->>RT: 执行 A.x 的结果
```

闲置回收：

```mermaid
sequenceDiagram
  participant RT as Runtime（core）
  participant L as 会话 MCP lease
  participant S as MCP server 进程
  RT->>L: callTool(A.x)
  L->>L: A 在途 +1，取消闲置计时
  L->>S: 执行 A.x
  S-->>L: 结果
  L->>L: A 在途 -1 → 重新计时 10 分钟
  Note over L: 10 分钟无使用、无 MCP App 连接、A 未声明 idleReclaim: false
  L->>L: 再确认后 release(A)，A 回到待首次使用（工具不变）
  L->>S: 空闲回收后关闭进程（mcp.idle_reclaim.closed）
  RT->>L: callTool(A.y)
  L->>S: 经首次使用路径重新连接后执行
```

- 子智能体借用父会话端口时读取**当前**连接状态与工具（而非启动时快照），"待首次使用"的 server 视为可用；子智能体的调用由父 lease 按同一规则首次连接。
- 插件引用提醒把"待首次使用"的 server 视为可用。

## 2. 内置插件摘要缓存与工作区展示复用

- 内置插件随应用版本不可变。文件系统来源的内置插件摘要（逐文件 SHA-256 与插件 hash）：
  - CLI 进程内按（插件根目录、插件名、插件版本、应用版本）记忆，进程内只计算一次。
  - 跨进程持久化到 `<插件存储>/official-plugin-digests.json`，键为应用版本 + 插件根目录 + 插件名与版本，校验值为**文件统计签名**（文件数、总字节数、最大 mtime、逐文件 path/size/mtime/mode 的摘要）。签名一致时直接复用摘要，不读文件内容；不一致时重新哈希并覆盖写入。
  - 复制到缓存时仍逐文件校验 SHA-256（不一致即报 hash mismatch，与原语义相同）。SEA 来源本来就使用清单内 hash，不变。
  - 非内置（用户安装、市场、项目）插件的完整性语义不变。
- 工作区展示（`workspace/readPresentation`）与会话快照的 `/` 命令目录：自定义命令发现对插件的解析结果（命令根目录）按（workspace、插件修订）在进程内记忆。插件修订由以下事实组成：生效配置中的插件段（启停、抑制、选项、额外市场、inline 目录）、插件存储中 `installed_plugins.json`、`known_marketplaces.json` 与官方插件缓存目录的统计签名。安装、卸载、更新、启停、恢复内置都会改变其中之一，下一次读取即重新解析；命令文件本身每次仍实时枚举。

## 3. CLI 传输分道

一个 CLI 进程服务整个 workspace。请求按下表调度，完整规则与时序图见 [CLI Agent Server 规格](../../apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md#请求调度分道)：

| 类别                                                                                                                                                       | 调度                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 反向请求的响应、网络观测控制                                                                                                                               | 收到即处理（不变）                                                  |
| 无会话的纯读：工作区展示、`session/list`、会话索引对账、命令时钟探测、插件/技能/工作流目录读取、用量、进程与能力查询、连接流控、`provider/refreshRegistry` | 收到即处理，不排队                                                  |
| 控制：`session/stop`、`workspace/cancelGenerateText`、`plugins/cancelOperation`、MCP App 请求                                                              | 等同一分道上一个请求进入 handler 后旁路执行                         |
| 携带会话（`sessionId`、conversation topic、命令信封或 `createSession.payload.sessionId`）                                                                  | 该会话分道内 FIFO；不同会话并发；涉及多个会话的请求同时占用这些分道 |
| 其他 topic（会话索引、工作区配置的订阅族）                                                                                                                 | 按 topic 分道 FIFO                                                  |
| `workspace/generateText`、`provider/testModelConnectivity`                                                                                                 | 模型分道 FIFO                                                       |
| 其余无会话请求（含未知方法）                                                                                                                               | 全局分道 FIFO                                                       |

EOF 后停止接单，等待所有分道与在途请求完成或 100ms drain 到期，与原规则相同。

## 4. 首轮 git 快照

- 每个快照只启动必要的 git：`status --short --branch`（分支名取自首行）、`for-each-ref`（一次读出 `origin/HEAD`、`origin/main`、`origin/master`）、`config user.name`、`log --oneline -n 5`，并行执行；原先 5–8 个。
- 同一 CLI 进程内按仓库缓存与工作区无关的部分（主分支、用户名、最近提交），键为 git 目录、`HEAD` 内容与索引文件统计（mtime + 大小）。命中时只运行 `status`。
- 工作区文件改动不会改变 HEAD 或索引修订，因此状态行每次都读取，保证"会话开始时的快照"语义。
- 输出字段与格式不变：状态行仍是 `--short` 格式并按 2k 字符截断；`status` 失败时回退 `symbolic-ref` 取分支名，与原先每个字段独立失败的结果一致。

## 5. 每轮 `subagents/readRuntimeConfig`

保持每轮读取，不缓存。原因：Host 的子智能体配置没有修订号，也没有向 CLI 推送变更通知，缓存无法正确失效；按规则不引入 TTL。若后续 Host 提供修订号或变更通知，再在 CLI 侧按修订缓存。

## 6. 本地性能事件

均为 info 级（启动失败为 warn），只写本机日志，不含正文，路径不入字段（server 名、方法名、会话 ID 除外）。供 1.1 本地性能摘要汇总。

| 事件                                                 | 触发                         | 关键字段                                                                                       |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `zcode_protocol.request.queue_wait`                  | 请求在分道内等待 > 50ms      | `method`、`lane`（session/topic/model/global/control）、`waitMs`                               |
| `zcode_protocol.request.slow`                        | handler 耗时 ≥ 500ms         | `method`、`lane`、`durationMs`、`queueWaitMs`                                                  |
| `mcp.manifest_cache.hit` / `mcp.manifest_cache.miss` | 会话启动登记每个 server      | `mcpServerName`、`toolCount`（命中时）                                                         |
| `mcp.lazy_start.started` / `.completed` / `.failed`  | 首次使用触发连接             | `mcpServerName`、`trigger`、`durationMs`、`manifestChanged`（完成时）、`error`（失败时，warn） |
| `mcp.background_start.completed`                     | 无缓存 server 后台连接结束   | `mcpServerName`、`status`、`durationMs`、`toolCount`                                           |
| `mcp.manifest_cache.drift`                           | 真实清单与缓存不一致         | `mcpServerName`、`cachedToolCount`、`toolCount`                                                |
| `mcp.idle_reclaim.closed`                            | 闲置回收释放会话连接         | `mcpServerName`、`idleMs`、`toolCount`、`sessionId`                                            |
| `mcp.startup.completed`                              | 会话启动登记完成             | `durationMs`、`deferredCount`、`backgroundCount`、`mode`（lazy/eager）                         |
| `turn.first_model_request.started`                   | 每轮首个主模型请求发出前     | `durationMs`（自本轮执行开始）                                                                 |
| `bootstrap.official_plugin_digest.resolved`          | 每个进程首次解析内置插件摘要 | `source`（memory/persisted/hashed）、`pluginCount`、`durationMs`                               |

## 验收与验证

- 单测：缓存命中时调用前不启动进程；缓存未命中时首个请求不阻塞、连上后下一步加入工具；清单漂移；首次启动失败返回结构化错误；会话关闭/取消时首次连接干净结束。
- 单测：闲置回收后下一次调用经首次启动路径重启；在途调用与 MCP App 连接阻止回收；声明有状态（`idleReclaim: false`）的 server 跨过闲置窗口仍保持连接而无状态 server 被回收；node_repl 由宿主声明有状态；会话关闭清除闲置计时器。
- 单测：跨会话并发、同会话保序、`createSession` → subscribe 保序、控制旁路、无会话读不排队、EOF drain。
- 单测：内置插件摘要命中时不读文件内容；工作区展示在插件安装/启停后重新解析。
- 单测：git 快照首次 4 个命令、缓存命中只运行 `status`，字段与原先一致。
- 未在真实 Windows 生产包上复测的数值不写成通过；本地测得的耗时只作为同机前后对比。

### 开发机前后对比（Windows 11，monorepo 源，非生产包）

| 项目                                | 之前                     | 之后                                                                        |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| 内置插件摘要（496 个文件 / 30.3MB） | 每次建 app 约 225ms      | 同进程后续 0ms；新进程复用持久化摘要约 90ms（只 stat）                      |
| 首轮 git 快照（当前仓库，真实 git） | 6 个 git.exe / 150–170ms | 首个快照 4 个 / 约 118ms；同仓库后续 1 个 / 约 106ms（status 本身约 100ms） |

MCP 首个请求耗时与传输排队未在生产包上复测，只有单测覆盖；上线后以本节性能事件汇总的本地摘要为准。

## Host 发送路径

范围：`packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `sendConversationCommandV4`、旧 `sendPrompt` 及共用的 `session/list`、`provider/refreshRegistry` 与浏览器环境上下文。目标是热会话点发送到 CLI admission 之间不再有每次发送的 CLI 往返或 Main 往返。

### 会话引擎缓存

- 所有者：Host 的 `ZCodeAgentService` 实例。键为 `workspaceIdentity?.trim() || workspacePath` 加 `sessionId`，值为 `SessionEngine`。会话引擎创建后不可变（`packages/shared/src/external-engine/CONTRACT.md`），缓存无需失效事件。
- 写入：`session/list` 查到该会话时写入（查不到不写，不把"未找到"缓存成 `zcode`），包括会话订阅前的项目谱系查询；V4 `createSession` 命令 ACK 为 `accepted` 且带 `sessionId` 时按命令配置写入；旧 `session/create` 成功后按请求引擎写入。
- 删除：V4 `deleteSession` 命令 ACK 为 `accepted` 时删除；容量上限 2048 条，超出按写入顺序淘汰最旧项。
- 读取：命中直接返回；未命中走原 `session/list` 查询。只读进程（无外部引擎装配）仍直接视为 `zcode`。
- 外部引擎就绪门禁、`createSession` 与握手语义不变。

### Provider 注册表刷新修订号

- 修订号所有者：Host 进程的 Provider Registry（`providerRuntime.registryService`）。修订号取其快照的 `sourceRevisions.config`，由随包配置与 Personal 配置的内容哈希组成；设置页、Provisioning 等 Host 内写入在返回前已等待注册表刷新，外部写入经 Personal 配置轮询进入同一快照。
- 每个 CLI 进程（`ZCodeProtocolClient` 实例）记录最近一次成功 `provider/refreshRegistry` 时的修订号。需要刷新的入口先读当前修订号：与该 CLI 记录相同则跳过刷新；不同、未记录或修订号不可读时照旧刷新，成功后记录发起前读到的修订号，失败不记录。
- CLI 进程换代即新的 client 实例，首次使用会刷新一次。并发请求可能各刷新一次，结果一致。
- 适用入口：V4 命令（`requiresProviderRegistryRefresh` 列出的类型）、旧 `session/send`、`session/create`、`session/resume`、会话订阅首帧前与 provider 就绪后的启动刷新。模型连通性测试与工作区文本生成仍每次强制刷新。
- 不用时间窗口判断是否刷新；判断只依据修订号相等。

### 浏览器环境上下文

- 环境上下文（标签数与当前 URL）是尽力附加的信息，不能阻止 prompt 准入。Host 当前没有页面存在性的廉价事实（标签列表归 Main 的 `BrowserGuestManager` 所有），因此不做"无页面跳过"的预判，改为限定等待。
- Host 收集 `list` / `listUserTabs` 的总等待上限为 150ms。超出时本轮不附带环境上下文，直接下发命令；迟到结果丢弃，不重试、不补发。Host→Main 浏览器桥的 30s 命令预算只用于 Agent 主动发起的浏览器命令，不再出现在发送路径上。
- 失败与超时都只记 debug 日志，不改变 prompt 正文。

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant H as Host ZCodeAgentService
  participant M as Main 浏览器桥
  participant C as CLI
  UI->>H: sendText(sessionId)
  H->>H: 引擎缓存命中（未命中才 session/list）
  H->>H: 修订号与该 CLI 记录相同则跳过 refreshRegistry
  H->>M: list / listUserTabs（最多等 150ms）
  M-->>H: 环境上下文或迟到丢弃
  H->>C: v4/command（admission → ACK）
```

### 验收

| Case  | 场景                                       | 断言                                                       | 验证层        |
| ----- | ------------------------------------------ | ---------------------------------------------------------- | ------------- |
| HSP01 | 同一会话连续发送两次                       | 第二次不调用 `session/list`                                | services 单测 |
| HSP02 | V4 `createSession` accepted 后发送         | 不调用 `session/list`；`deleteSession` accepted 后重新查询 | services 单测 |
| HSP03 | 修订号不变连续发送 / 修订号变化 / CLI 换代 | 只在首发、修订号变化和新 client 时刷新                     | services 单测 |
| HSP04 | Main 不回应环境上下文请求                  | 150ms 内下发命令且不带环境上下文                           | services 单测 |

## Renderer 发送路径

### 草稿模型就绪门禁

- 所有者：Host 的 Model Selection 服务；Renderer 的 `useDraftModelReadinessGate` 只持有订阅投影（挂载时一次 `getView` + `onDidChange` 事件）。
- 首发复查 `ensureReadyForSend` 读取订阅投影：`ready` 直接放行，不发 IPC；`check-failed` 放行并交给 Host 门禁；初始读取在途时等待同一次读取，不再新发请求；只有投影为 `missing` 时才做一次权威 `getView`，确认无模型才拒绝。
- 迟到结果仍按草稿生命周期 scope 丢弃，不覆盖新草稿。

### Gen UI 上下文

- 所有者：Desktop Local Host 的 Gen UI 状态存储。Renderer 每个 SessionPane 持有一个只读上下文读取器（`createGenUiModelContextReader`），按 `buildGenUiScopeKey`（workspace identity + sessionId）缓存 `listState` 结果。
- 失效契约：`onStateChanged` 收到同一 scope 的任何变更即删除该 scope 缓存；读取期间收到变更时，本次结果只用于本次发送，不写入缓存。Host 存储对已监听目录内的文件写入发布变更，包括其他窗口写入、本窗口尚未打开过的 widget 路径。
- 发送时命中缓存直接拼接上下文；未命中才读取一次。读取失败按原逻辑忽略上下文，不阻断发送。
- 已知边界：本窗口 Host 从未打开过该会话任何 widget、而另一窗口写入了该会话状态时，本窗口缓存可能缺少该状态，直到本窗口打开该会话的 widget 或 SessionPane 重建。

### 草稿首发的"正在发送"

- 1.1 决策取代 [草稿首发：任务列表与详情同时提交](../task-first-submit-visibility.md) 中"等目录真实行再结束转圈"的规则：`sendText` ACK 为 `accepted` 后立即提升草稿并导航到新会话，Composer 的"正在发送…"随之结束。
- 侧栏真实行仍由 `ProjectDirectoryProvider` 的既有目录刷新带来，可以晚于详情出现；不构造乐观行。任务分组归属（organize）仍等真实行到达后提交。
- 目录读取失败只记 warn：会话已创建，不重发输入、不回滚导航。

## 启动恢复

- 所有者：Renderer 工作台拥有 Tab 布局与可见性；SessionPane 决定何时订阅会话；CLI 在订阅到达时冷恢复 runtime（含外部引擎 `session/load` 连接），该行为不变。
- 规则：绑定已有会话的 SessionPane 在首次可见（工作台布局中未隐藏）前不取得 `SessionDataLayer` 租约，因此不订阅、不触发 CLI 冷恢复和外部引擎后台连接。首次可见后取得租约；之后即使隐藏也保留租约，切换 Tab 不重复订阅。
- 启动时只有每栏当前 Tab（窄屏或浮窗时只有焦点栏）会恢复；其他已打开 Tab 激活时恢复。
- 不受影响：草稿 Tab 的预热、自动化、定时任务、机器人与后台任务。它们经 Host 命令进入 CLI，CLI 在命令 admission 前按原冷恢复路径恢复 runtime，不依赖界面订阅。
- 隐藏 Tab 的恢复守卫（删除检测）仍走 sessions-index，不依赖会话订阅。

```mermaid
sequenceDiagram
  participant W as Renderer 工作台
  participant P as SessionPane（可见）
  participant Q as SessionPane（隐藏）
  participant H as Host
  participant C as CLI
  participant E as 外部引擎 adapter
  W->>P: 恢复布局：当前 Tab 可见
  W->>Q: 恢复布局：后台 Tab 隐藏
  P->>H: subscribe(conversation)
  H->>C: v4 subscribe（historyFirst）
  C-->>P: 历史首帧
  C->>C: 冷恢复 runtime
  C->>E: 外部会话 session/load（仅可见会话）
  Note over Q: 不取租约、不订阅
  W->>Q: 用户激活该 Tab（可见）
  Q->>H: subscribe(conversation)
  H->>C: v4 subscribe → 冷恢复
```

### 验收

| Case | 场景                        | 断言                                              | 验证层              |
| ---- | --------------------------- | ------------------------------------------------- | ------------------- |
| SR01 | 已有会话 Tab 以隐藏状态挂载 | 不调用 `layer.acquire`                            | UI 单测             |
| SR02 | 隐藏 Tab 变为可见后再隐藏   | 可见时取得一次租约，再隐藏不释放                  | UI 单测             |
| SR03 | 真实桌面重启，恢复 6 个 Tab | 启动后只有可见会话出现 resume 日志；首发确认 ≤ 1s | 待真实 Windows 验证 |

## 本地性能摘要

- 所有者：Renderer 的 `LocalTtftObserver`（点击总时钟）；摘要经 `IPlatformService.writeLocalDiagnosticLog` 写入桌面本地日志（Renderer → Main `zcode:log` → `~/.zcode/v2/logs/YYYY-MM-DD.log`），生产包同样落盘。Web 不实现该方法，不输出摘要；不新增任何上传。
- 每次已下发命令的观测在闭合时输出一条 info 摘要：首个内容出现（`first_output`）或在此之前被排除/失败（`excluded`）。未下发命令的拒绝（例如 UI 门禁拦截、斜杠命令）不输出摘要。原 debug 明细记录保持不变。
- 字段只允许数字、布尔、枚举与生成的标识（sessionId、commandId、observationId）；不含 prompt、回复、错误正文、工作区路径或 provider/model 名称。
- 阶段（毫秒，缺失为 null）：`clickToPreviewMs`（点击 → 提交预览 commit）、`clickToAckMs`（点击 → Renderer 收到 ACK）、`clickToReceivedMs` / `clickToAdmittedMs`（点击 → CLI 收到 / 准入，仅时钟已校准时）、`enginePrepareMs`（CLI 记录的外部引擎准备）、`requestToFirstContentMs`（请求交付 → 首个内容，CLI 时钟）、`totalMs`（点击 → 首个内容或闭合）。另含 `outcome`、`engine`、`start`、`sendMode`、`quality`。
- `start`：本 Renderer 进程内该会话的第一条摘要记为 `cold`（启动后首发、打开历史会话后首发、草稿首发），同会话之后为 `warm`。它不证明引擎进程是否新建，引擎实际耗时以 `enginePrepareMs` 为准。
- 详见 [本地 TTFT 计时](../trace/local-ttft-diagnostics.md)。

## Windows 工作区路径大小写

- 已确认问题：本地 workspace key 为原始 `workspacePath` 字符串，Host 进程管理器按该 key 启动 CLI；Windows 文件系统大小写不敏感，而 `--open-workspace` 参数、deep link 与终端输入保留用户输入的大小写，Tab 去重和 Main 窗口映射也按原样比较。同一目录以不同大小写打开会得到两个 Tab、两个 CLI 进程和两份互不可见的会话列表。
- 修复：Main 在本地 Windows 路径进入工作区前，把每一段替换为磁盘上的实际大小写（逐级 `readdir` 匹配，盘符大写），不解析 junction、符号链接、subst 或网络映射。入口为 `activateOrSetWorkspace`（返回规范路径，Renderer 用它建 Tab 与草稿）和冷启动的显式工作区参数。`workspaceIdentity` 规则不变：远端 identity 与非 Windows 路径不做处理，共享 `resolveWorkspaceKey` 不变，已持久化的数据不迁移。
- 匹配失败（权限不足、路径段不存在、8.3 短名）时保留该段原文。
- 已有存量：旧版本以非规范大小写保存的 Tab、项目根或会话不会被改写；它们与规范路径仍是不同 key，需要在真实 Windows 上确认是否需要迁移。
