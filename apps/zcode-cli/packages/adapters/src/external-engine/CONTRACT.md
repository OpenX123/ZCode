# ACP NDJSON adapter

原生分叉通过 forkSession 使用目标本地 session ID 创建独立连接，沿用源 connectionProfileId 与目标 cwd；缺省 profile 的历史固定 inherit。initialize 必须声明 sessionCapabilities.fork 才发送 session/fork，否则返回 typed unsupported。分叉不发送 prompt、不重试未知创建结果、不重放父会话正文或 pending permission；确认的新原生 ID 必须不同于父 ID，随后可复用连接或冷恢复 child。

2026-11-06：Codex 连接配置 ID 随 Runtime 的 external_engine_config entry 固定；旧原生 ID 默认 inherit。管理连接设置专用 CODEX_HOME，仅通过私有 providers/set 发送 API Key，禁止密钥进入 argv、普通 V4 命令与快照。剔除 APP_SERVER_LOGS，禁用原生完整帧日志。首次初始化后、session/new/resume 前应用网关；健康会话复用，不在每轮重复配置或认证。

只运行 shared 描述的锁定 ACP adapter。入口经 exec 基础设施启动；NDJSON 限制单行大小，严格 JSON-RPC id 关联，通知串行 await，禁止原始 stderr/帧进入日志。session/new/resume 完成后才 prompt；权限选项保持原 id。退出拒绝请求，关闭杀进程树；不读取官方凭据或 transcript。

prepareSession 与 runTurn 共用连接和初始化路径，首次 prompt 复用已准备的会话。Electron Helper 子进程显式设置 ELECTRON_RUN_AS_NODE=1，退出错误包含 code 或 signal。

运行中的 set_config_option 与 prompt 共享同一健康连接；JSON-RPC 业务拒绝只拒绝该配置请求，不关闭连接或取消 prompt，传输失败仍回收连接。

新连接初始化时 configValues 是 Runtime 上次确认的选择；依照 resume 最新目录恢复后再发布 configOptions。缺失值明确失败并关闭失败连接，不能静默回落新会话。

新建 Claude 会话未确认 mode 且原生当前为 default 时，目录支持 auto 才通过现有配置 RPC 选择 Auto；发布原生实际返回值，保留模型限制的调整。已有会话、已确认选择、其他原生模式和 Codex 不应用新建默认值；不写用户 CLI 设置或绕过权限。

prepareSession 是同会话 single-flight 的连接恢复入口：只对连接/超时/internal error 有限退避重试；closeSession 与 signal 中止在途准备和退避。runTurn 只在 prompt 前复用准备，prompt 从不自动重发。恢复协商 resume/load 能力，load 不重放用户正文/工具至回调；保留原 externalSessionId 和已确认配置。未确认 session/new 的失败不自动重发。

错误采用 ExternalEngineConnectionError 与 EngineConnectionFailure；只暴露分类、方法、数值 rpcCode、HTTP 状态、request id 与脱敏短消息，不暴露原始 message/data/stderr。initialize 声明原生 plan 能力，计划清单和文档沿同一通知队列发布。

prompt 响应允许 usage 缺省或为 null，均不产生用量，不回收健康连接。取消等待超时使用结构化 timeout 错误，Runtime 可通过既有 prepareSession 恢复原会话；adapter 不重发 prompt。

PATH 缺 node 时，为 ACP 子进程补充托管运行时入口（POSIX 符号链接 node，Windows node.cmd），复用当前 Node/Electron Node 模式；不修改系统 PATH 或用户官方 CLI。

2026-11-07：两家引擎都按会话绑定的连接配置构造环境，规则来自共享 `buildEngineConnectionEnv`：Claude 沿用 CLI 保留 ANTHROPIC\_\*，官方登录与无绑定旧会话去除三项计费变量，API Key 只经子进程环境注入（官方地址 ANTHROPIC_API_KEY，网关 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN）；Codex 规则不变。新草稿无显式绑定时取 Host 记录的上次使用值，首次解析后在重试中固定。adapter 环境经 `applyNetworkEgressEnv` 恢复用户代理/证书变量，YCode 显式配置优先。`runExternalEngineConnectionTest` 复用同一 port 在临时 cwd 建一次性会话发送最小 prompt，拒绝工具权限，首个原生失败即结束，结束后关闭会话并删除临时目录；结果不含密钥、原始帧或 stderr。

2026-11-09：`createExternalEngineProcessPool` 是每 CLI 一个的进程所有者；窗口 Host 独占一个未绑定备用许可，受控 CLI 通过注入 budget 申请/释放，未授权不 spawn。pool 可领用索引不等于资源所有权：warming 同步独占 reservation，取消关闭当前或迟到连接，close 等全部未交付资源；已交付连接归 port。cwd/engine/profile/generation 隔离；identity 每次读真实配置与凭据，内部摘要不出 adapter。命中只 stat 已知安装入口与 executable，不再完整 PATH 解析；miss 的解析结果直接用于补位，无第二 launch 缓存。申请未答复直接 miss；release ACK 不阻塞前台；撤销关闭未绑定进程完成后才释放/ACK，并发 close 共享同一个完成 Promise。10 分钟备用 TTL 与会话 10/15 分钟 idle 规则保持。性能事件增加 `external_engine.spare.reserved`，不包含路径/凭据/内部 generation。

`createExternalEnginePort().prepareSpare(engine, connectionProfileId, cwd)` 不创建 Runtime 会话，供已有业务 CLI 的 Host 低优先准备使用；测试连接独立 port 不接入池。缺省未注入 pool 时保持无备用行为。

2026-11-08（1.1）：备用进程升级为预建会话。池补位时调用 `AcpConnection.prebuild(engine, cwd)`：initialize（含 providers/set）→ 该 cwd 的 `session/new` → 新会话默认配置（Claude Auto），从不提交 prompt、不调用会话回调；领用前的通知留在初始通知缓冲。新会话（无 externalSessionId、非 fork）领用后，`prepare` 跳过 initialize 与 `session/new`，以预建原生 ID 调 `onSession`，按原规则下发 `configValues`（含显式模式）后 `onConfigOptions`，再回放缓冲通知；预建连接不接受 resume/load/fork。本机实测两家未提交 prompt 的会话关闭后不写原生会话历史，关闭不做额外清理。

2026-11-08（1.1，闲置回收）：取消“最近 3 个可恢复会话”豁免与草稿不关闭。`pool.setVisibleSessions(sourceId, sessionIds)` 整体替换某来源（V4 连接 ID）的可见会话，空集删除该来源；可见集合为各来源并集，从未上报视为不可见。池每 60 秒关闭不可见、无在途、闲置满窗口的连接：可恢复会话 15 分钟，草稿（经 `session/new` 或领用预建会话建立、从未 prompt）10 分钟；`external_engine.idle_close` 带 `kind`（prompted / draft）。port 记录草稿的原生 ID（`draftNativeSessionId`，提交第一个 prompt 时清除）；连接不在时若 `prepareSession` 收到的 `externalSessionId` 正是该草稿 ID，就忽略它改走 `session/new`（可领用预建会话），经 `onSession` 交回新 ID 并按 `configValues` 恢复配置，绝不 resume 从未 prompt 的原生会话。

2026-11（1.1.0）原生子智能体：initialize 两家都声明 `clientCapabilities.subagents`（Codex 保持 AIR，Claude 不是 AIR）。`subagent-frames.ts` 把 AIR 草案与 RFD 帧归一为 `onSubagent` 事件，连接级登记已宣告子 sessionId；其更新经 `onChildUpdate`，权限请求带 `childNativeSessionId`（判定前先排空已到达的通知，保证 spawned 先登记）。未宣告的非主 ID 丢弃、权限回 cancelled，并经 `onDiagnostic` 留无正文诊断；load/fork 回放丢弃全部子智能体帧。`cancelSubagent` 只对声明 cancel 的子会话发送 `session/cancel`，否则抛 unsupported。无效子智能体帧不判定连接故障。

Task3 审查修复：未绑定备用从构造起选择 `closeAcpProcessAndWait`，包括连接内部错误触发的自关闭；pool 显式要求严格关闭。该 exec 入口先记录进程身份/树，再发终止，确认 OS 中同身份/组的非僵尸进程消失才 resolve；taskkill 失败或观察失败且仍存活则 reject。pool 保留 owned/许可并拒绝成功 ACK；后台失败附 catch 不产生未处理拒绝。已交付仍归 port，预算交接不等待后台授权/释放回复。

迟到 launch 的后台关闭失败不被日志 catch 转换为撤销成功：retire 等待准备结束后再次确认当前连接的严格关闭。快照中已归属的 PID 身份不可被复用后的新身份覆盖。port 开始会话操作后恢复普通会话关闭策略；前台启动/命中不执行进程表查询。
