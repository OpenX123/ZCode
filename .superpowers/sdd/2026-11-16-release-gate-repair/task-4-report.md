# Task 4：已退役商业服务测试边界迁移

状态：DONE_WITH_CONCERNS。仅修改 brief 指定的九个原失败测试文件和凭据迁入 suite，共十个测试文件；未修改生产实现、架构策略、Vitest 配置、timeout 或 skip。现有 standalone spec 与门禁修复 spec 已规定本次退役/保留合同，无新增产品行为，无需额外 UI E2E。

固定审查 BASE：eb295a3e。执行期间 controller 追加 f858d6fc（计划/spec），本任务测试变更仍以既定 BASE 审查。Node v24.14.0，pnpm 10.33.2。先读 brief、AGENTS、architecture-governance、standalone spec 和补充门禁 spec；后补读全局 subagent-driven-development/implementer-prompt.md。未派子代理。

## 逐文件旧失败与新覆盖映射

| 文件                                                         | RED / 当前 owning source                                                                                          | 迁移与仍保留的正向验收                                                                                                                                                                                                                                                                   | 首次 GREEN / 最终复跑                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| packages/client/test/remoteServiceAccess.test.ts             | 1 个失败；RemoteServiceAccess 已无 clientConfigService，保留 ProviderSettings getter                              | getView 的真实 ProxyChannel 调用、方法/参数/频道；显式断言不创建 client-config；Source 管理可选频道与 window-project 显式能力原用例不变                                                                                                                                                  | 3/3；3/3                                                     |
| packages/desktop/test/hostRemoteWorkspaceServices.test.ts    | 2 个失败；remoteWorkspaceServiceCollection/sourceSettingsServiceCollection 无 client-config、官方订阅和账号 OAuth | 清除过期导入/注入；保留全部 18 个用例：四种 transport 控制端分组与广播、Source 文件/模型/Provider 权威、普通凭据、onboarding 真 RPC、旧 Server 路径/目录、Provisioning 私有执行器                                                                                                        | 18/18；18/18                                                 |
| packages/desktop/test/remoteConversationShareWiring.test.ts  | 1 个 collection 导入失败；已删除 Share attachment wrapper；当前注册表无云分享频道                                 | 不再导入/模拟不存在模块；SSH/WSL/Docker/server 四种真实服务集合暴露均无 conversation-share；通过真实 ChannelServer/Client RPC 完成 Source readTextFile 和 getImportedConversation 参数/返回值往返；重装配切换新 Source 文件服务，旧连接零调用                                            | 5/5；5/5                                                     |
| packages/desktop/test/remoteWorkspaceSessionServices.test.ts | 1 个失败；renderer merge 不覆盖已退役 conversationShareService                                                    | 删除虚构 Share、已不存在于 IServiceAccessor 的账号 OAuth/clientScenes fixture 与断言；普通 setting/credential/broadcast 的本地 fallback 仍保留，file/runtime/hooks/Provider 远端覆盖、Source/legacy 权威差异以及 hooks 原 workspaceIdentity 真 RPC 不变                                  | 5/5；5/5                                                     |
| packages/services/test/conversationShareComposition.test.ts  | 2 个失败；createLocalServices 已无 IConversationShareService                                                      | 真实装配不注册 conversation-share/telemetry，不导出账号 loader，无 fetch 业务请求；保留模型 getView；显式 desktop-local 与 desktop-attached-remote 对 ProvisioningTarget 的未注册/已注册权威差异；每个 case 独立临时配置，仍 await disposeServiceResourcesAndWait 后清理 HOME            | 2/2；1/2（本地 case 的 afterEach 清理 EPERM，详见 concerns） |
| packages/services/test/servicesEntryBoundary.test.ts         | 2 个失败；services root/node 不再导出官方 Share 接口/实现                                                         | 动态 namespace 检查两入口均无 interface/runtime/error/http/mock/scope factory；正向检查普通 File/Credential descriptor，createLocalServices/createFileService/createCredentialService 仅 node 导出                                                                                       | 2/2；2/2                                                     |
| packages/services/test/telemetryUserIdLoader.test.ts         | 1 个失败；node 无 createTelemetryUserIdLoader                                                                     | root/node 均无旧账号 loader；不恢复账号读取调用；原通用“解密失败不删除凭据”迁入 credentialService suite                                                                                                                                                                                  | 1/1；1/1                                                     |
| packages/shared/test/officialMcpAuthProtocol.test.ts         | 6 个失败；zcode-protocol 无官方身份 schema/反向 method                                                            | namespace 检查请求/响应 schema 和 method/contract 均退出；HTTP/SSE/stdio 普通最小声明正向解析，添加旧 zcode_official auth 后全部拒绝，不能匿名降级                                                                                                                                       | 4/4；4/4                                                     |
| packages/zcode-server-cli/test/coreHttp.test.ts              | 1 个失败；Core HTTP 不装配 Share                                                                                  | Web 与可信 Host 真实 WebSocket RPC 均拒绝未注册的 conversation-share；普通 Web 经过 hello/clientHello 后无法伪造 desktop 可信身份，普通 rows RPC 保留；Host 的 rows RPC 继续承载可信下游；其余 Host capability、重放/过期拒绝、Provisioning 受信边界、资源 owner/identity 与关闭测试保留 | 10/10；10/10                                                 |
| packages/services/test/credentialService.test.ts             | 通用断言迁入目的地；credentialService.load 只解密并抛错，不写回/删除                                              | 在本次临时目录写损坏 enc:v1 密文；真实 load 抛 CREDENTIAL_DECRYPT_ERROR_CODE，文件逐字不变、其他普通凭据可读、mutation listener 零调用；夹具设置独立密钥并恢复原 HOME/密钥环境（缺省时删除变量），不读真实凭据                                                                           | 7/7；7/7                                                     |

普通 MCP HTTP header、OAuth client_credentials/authorization_code 正向转换仍由未修改的 packages/shared/test/mcp.test.ts 的 17 项验证。未修改的 standaloneProviderRuntime 4 项实际验证普通 GLM API、历史套餐选择不回退、SSH Personal 分发/幂等/旧凭据保留、getImportedConversation 本地正向读取与缺失返回 null；没有恢复云 API。

## 验证命令与原始事实

所有 pnpm 命令都在仓库根执行，PATH 前置固定 Node bin：C:/Users/21132/scoop/persist/nodejs-lts/cache/\_npx/3e062c1ecdbab29f/node_modules/node/bin。没有输出真实环境变量值、真实凭据或日志正文到最终报告。原始运行文件保留于 scratch/task-4，不改写失败记录。

1. 开工 freshness：node scripts/check-workspace-freshness.mjs，exit 0；分支相对 origin/main ahead 35 / behind 0，无远端跟踪分支提示。
2. 修改前：pnpm architecture:check --changed，exit 0，violations 0 / baseline 0 / new 0；architecture-before.log。
3. RED（修改前九个精确文件）：exit 1，9 个文件结果，48 tests = 16 failed + 32 passed；另有 wrapper 删除导致的 1 个 collection 导入失败（该文件未执行断言）。Vitest numTotalTestSuites 包含 describe 计数，不作为文件数使用。记录为 red.json / red.log，不能与外部初始基线报告混为同一次运行。

```powershell
pnpm exec vitest run packages/client/test/remoteServiceAccess.test.ts packages/desktop/test/hostRemoteWorkspaceServices.test.ts packages/desktop/test/remoteConversationShareWiring.test.ts packages/desktop/test/remoteWorkspaceSessionServices.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/servicesEntryBoundary.test.ts packages/services/test/telemetryUserIdLoader.test.ts packages/shared/test/officialMcpAuthProtocol.test.ts packages/zcode-server-cli/test/coreHttp.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/red.json
```

4. 首次迁移后批次：同上九文件，加 credentialService.test.ts、standaloneProviderRuntime.test.ts、mcp.test.ts 和 windowHostAttachmentRpcPolicy.test.ts，exit 1，13 文件 82 tests = 81 passed + 1 failed。九个迁移文件 50/50，凭据 7/7、Provider/历史 4/4、MCP 17/17；唯一失败为独立 R3 的旧频道计数（实际 40，预期 46），其余 policy RPC 3/3 通过。未改 policy 文件；green-1.json / green-1.log。

```powershell
pnpm exec vitest run packages/client/test/remoteServiceAccess.test.ts packages/desktop/test/hostRemoteWorkspaceServices.test.ts packages/desktop/test/remoteConversationShareWiring.test.ts packages/desktop/test/remoteWorkspaceSessionServices.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/servicesEntryBoundary.test.ts packages/services/test/telemetryUserIdLoader.test.ts packages/shared/test/officialMcpAuthProtocol.test.ts packages/zcode-server-cli/test/coreHttp.test.ts packages/services/test/credentialService.test.ts packages/services/test/standaloneProviderRuntime.test.ts packages/shared/test/mcp.test.ts packages/desktop/test/windowHostAttachmentRpcPolicy.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/green-1.json
```

5. 自审后修正：新迁入凭据 IO 改用异步 readFile/writeFile、夹具固定并恢复密钥，删除 renderer fixture 中不存在的账号 OAuth/clientScenes；Core RPC URL 沿用既有模板字符串并移除无行为价值的 expose 次数 spy。最终复跑九迁移文件加三个迁入保留 suite，exit 1，12 文件 78 tests = 77 passed + 1 failed；失败是 composition 本地 case afterEach 删除临时 bot-config.v3.json.lock 时 EPERM，并非 Share/Provider 断言失败。未追加重试或延时；green-final.json / green-final.log。

```powershell
pnpm exec vitest run packages/client/test/remoteServiceAccess.test.ts packages/desktop/test/hostRemoteWorkspaceServices.test.ts packages/desktop/test/remoteConversationShareWiring.test.ts packages/desktop/test/remoteWorkspaceSessionServices.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/servicesEntryBoundary.test.ts packages/services/test/telemetryUserIdLoader.test.ts packages/shared/test/officialMcpAuthProtocol.test.ts packages/zcode-server-cli/test/coreHttp.test.ts packages/services/test/credentialService.test.ts packages/services/test/standaloneProviderRuntime.test.ts packages/shared/test/mcp.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/green-final.json
```

6. 静态检查：对 git diff --name-only -- '\*.test.ts' 返回的十个本任务文件执行 pnpm exec oxfmt（exit 0）、pnpm exec oxlint（exit 0，0 warning / 0 error）、pnpm exec oxfmt --check（exit 0，10 files）、git diff --check（exit 0）。日志为 format-write.log / format-write-2.log / lint-changed.log / format-check.log / diff-check.log。pnpm 仅有仓库已有 package.json pnpm 字段忽略提示；Git 有 Windows LF/CRLF 提示，未做全仓换行重排。
7. 修改后：pnpm architecture:check --changed，exit 0，violations 0 / baseline 0 / new 0；architecture-after.log。该策略不覆盖未配置模块的全部语义，不能据此宣称 runtime 全绿。
8. 根 pnpm typecheck / pnpm lint、29 规格和完整 pre-push 按 controller 安排在整批最终统一执行，本子任务没有把定向 lint 当作根 lint。未运行全量 pnpm test/test:unit。

## 自审与 concerns

- 已逐项读本任务 diff，生产源码零改动；保留混合 suite、真实 RPC 与普通 API/OAuth/SSH/identity 验收，没有恢复退役模块、无不存在模块 mock、无 skip/timeout 调整/断言降级。
- 已知独立 R3：windowHostAttachmentRpcPolicy.test.ts:33 旧 46 计数仍失败，实际 40；本任务未改，不声称 13 文件全绿。
- 新观察到一次 composition cleanup EPERM：失败对象为本次临时目录下的 bot-config.v3.json.lock，await disposeServiceResourcesAndWait 后仍未能删除。保留首次通过与最终失败事实，未使用 rm 重试、sleep 或 getStatus 隐藏锁屏障。
- 已确认源码事实：node.ts:2150 对所有非 desktop-attached-remote 模式启用 Bot startup，原 undefined 与本次 desktop-local 在此一致；botsService.ts:9903-9911 fire-and-forget 三个 refresh 和 ensureBotStorageMigrated。ensureBotStorageMigrated（2279-2291）等待 repo.readConfig/readState；BotsRepo.readConfig（repo.ts:42-56）使用文件锁。botsService.disposeAllAndWait（9844-9897）的完成 Promise 等待 cancelUploads 与三个 runtime dispose，没有直接等待 migration/startup continuation；telegramChannelRuntime.ts:406 的 dispose invalidate refreshQueue 后等待活跃轮询，不直接等 refresh 在途 Repo IO。
- 待验证假设：上述未等待的 startup/refresh IO 可能使全局 async dispose 返回后仍占用配置锁。一次 EPERM 与静态源码不足以确认唯一生产根因，其他文件系统时序因素尚未排除。遵照 brief 不跨任务改生产；controller 已决定独立调查/修复生命周期问题，本任务以 DONE_WITH_CONCERNS 交接。
- 未覆盖：真实 UI/官方网络调用（本任务没有产品 UI 变更）；分享旧历史的实际本地解析由 standaloneProviderRuntime 既有正向/缺失用例覆盖，远端 wiring 用例只证明服务路由与参数往返。

## RED 失败标题（原始记录摘录，无原始日志或环境值）

### remoteServiceAccess.test.ts

- RemoteServiceAccess 公开配置经独立频道 RPC 读取

### hostRemoteWorkspaceServices.test.ts

- server remote workspace host service wiring exposes only non-provider configuration channels for a Source settings attachment
- server remote workspace host service wiring keeps the Source Server runtime authoritative for every forwarded service family

### remoteConversationShareWiring.test.ts

- collection 失败：导入已经删除的 conversationShareAttachmentService.js；未进入断言执行。

### remoteWorkspaceSessionServices.test.ts

- buildRemoteWorkspaceSessionServices uses remote filesystem/runtime services and keeps local global services

### conversationShareComposition.test.ts

- conversation share service composition registers a real API-backed service for a local desktop host
- conversation share service composition keeps desktop-attached remote hosts behind the publishing boundary

### servicesEntryBoundary.test.ts

- services package entry boundaries keeps conversation-share runtime implementations out of the browser-safe root entry
- services package entry boundaries exposes conversation-share runtime implementations from the node entry

### telemetryUserIdLoader.test.ts

- createTelemetryUserIdLoader keeps telemetry credential reads best effort when OAuth credentials cannot decrypt

### officialMcpAuthProtocol.test.ts

- official mcp auth headers protocol registers the reverse request under the interaction namespace
- official mcp auth headers protocol accepts a minimal request and a remote workspace identity
- official mcp auth headers protocol is strict, so a smuggled credential field is rejected
- official mcp auth headers protocol requires every identifying field to be a non-empty string
- official mcp auth headers protocol accepts both response branches
- official mcp auth headers protocol rejects unknown reasons, free-text errors and cross-branch fields

### coreHttp.test.ts

- standalone Server Core ingress Share RPC 只接受 Host 的可信下游，普通 Web 不能伪造 desktop 身份

# Task 4 Fix 1：完成 Bot 启动与异步关闭的 owner 收口

状态：DONE。独立审查 I1 对应最终 GREEN 缺口已补上确定性回归与通过证据；原报告、原 EPERM 与全部 RED 日志保持不变。Fix BASE 为 215107a2，修复开工 HEAD 为 b9cf0f5d（包含 controller 合同和独立 Task 5）；本次只提交以下两个实现/测试文件和本报告追加。controller 已先在 docs/testing/1.4.1-gate-repair-spec.md 的“服务释放边界”明确唯一 owner、时序和完成语义，本次不重复改该 spec。

## 实现及直接证据

- packages/services/src/bots/botsService.ts：复用现有 shutdownPromise，持有三个真实 startup refresh 及存储初始化/恢复 continuation 的聚合 startupPromise。关闭仍同步调用三个 runtime.dispose 失效刷新代次和停止活动连接，同时等待这些已接纳启动 Promise 完成。并发关闭返回同一 shutdownPromise，不增加公开 API、重复生命周期 owner、计时状态或底层 runtime 队列。
- 初始化 continuation 在存储读取和每个恢复 await 后检查现有 shutdownPromise；群恢复在配置/连接 await 后检查关闭状态；startTaskStream 的无 await 订阅提交点再检查关闭状态，避免 task service/权限晚到后重新 add 订阅。中文注释说明关闭提前完成与 Repo 文件锁清理竞争，以及 taskStreamHub.dispose 本身不能阻止后续 add。
- 原有初始化失败 error 日志保留，三个 startup refresh rejection 用与现有 scheduleRefresh 相同的 warn 形态记录并接入完成 Promise，不产生未处理 rejection，也不把初始化失败改成业务成功。正常运行时不修改配置、Provider authority、owner/identity/ACK 或流投递合同。
- packages/services/test/botsService.status.test.ts：复用当前 memory Repo 与既有服务夹具，新增 6 个回归。空 Bot 配置覆盖 storage/refresh/recovery 三个受控 Repo IO 阶段；另覆盖启动失败可见且关闭幂等，以及群恢复等待 connection/task-service 的两个晚到订阅场景。没有真实网络、sleep、固定次数微任务循环或文件删除重试；composition authorityMode、清理与断言完全未改。

单次 setImmediate 只作为事件循环检查点观测原关闭 Promise 是否已经 settle，不代表 IO 完成屏障。每个阶段的真实入场由 Repo deferred resolve 确认，IO 完成由独立 deferred 释放；唯一完成验收是 await 原 disposeAllAndWait Promise。用例 finally 始终释放本次 deferred 并等待关闭，避免失败回归泄漏测试资源。

## RED → GREEN 的六个回归映射

| 新回归                                                            | RED 所在代码状态 / 真实失败                                                                                                                                         | 最终 GREEN          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| storage Repo IO 未结束，关闭应保持 pending                        | 原实现；fix1-red.json：disposed 为 true（应 false），证明初始化 IO 未完成时关闭已提前完成                                                                           | status 11/11 中通过 |
| refresh Repo IO 未结束，关闭应保持 pending                        | 原实现；fix1-red.json：disposed 为 true（应 false），证明已进入 Provider refresh 的 Repo IO 不在原关闭完成范围                                                      | 同上                |
| recovery Repo IO 未结束，关闭应保持 pending，之后不再读取恢复配置 | 原实现；fix1-red.json：disposed 为 true（应 false），证明 continuation 仍在读状态时已提前完成                                                                       | 同上                |
| 启动 Repo 失败可见、关闭同 Promise、无未处理 rejection            | 原实现；fix1-red.json：原三个 refresh 没有 warn 日志，预期 3 次实际 0；初始化 error 原本保留。修复后同一错误分别走初始化 error 与三个 refresh warn，runner 成功退出 | 同上                |
| 群恢复等待 connection 时关闭，晚到不能建订阅                      | 首次 startup owner 补丁后；fix1-recovery-red.json 9/10，及 fix1-recovery-red-2.json：subscribe 实际调用 1 次（应 0）                                                | 同上                |
| 群恢复等待 task-service 时关闭，晚到不能建订阅                    | 首次 startup owner 补丁后；fix1-recovery-red-2.json：subscribe 实际调用 1 次（应 0）                                                                                | 同上                |

以上确定性回归确认了“已接纳启动任务未被关闭等待”与“关闭后可晚到重建群订阅”两个已有生命周期缺陷，不再仅靠原单次 EPERM 推测。不能反推原文件系统 EPERM 的全部可能原因都已排除；实际 composition 未改夹具并再次通过，为本次 I1 提供闭环验证。

## 执行命令、退出码与统计

全部从仓库根运行，固定 PATH Node bin 与原报告一致，Node 24.14.0 / pnpm 10.33.2。所有原始输出位于 scratch/task-4/fix1-\*，未覆盖原 red/green/EPERM 日志；本节只列脱敏结果。

| 命令 / 日志                                                                                                                                                                      | exit | 结果                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| node scripts/check-workspace-freshness.mjs                                                                                                                                       | 0    | ahead 42 / behind 0，无远端跟踪分支提示                                                                                          |
| pnpm architecture:check --changed；fix1-architecture-before.log                                                                                                                  | 0    | violations 0 / baseline 0 / new 0                                                                                                |
| pnpm architecture:context services；fix1-services-context.log                                                                                                                    | 0    | 当前 services 是 legacy unmanaged；无额外已声明 CONTRACT/依赖，已结合直接 owning source 阅读，不将 context 误写成 managed 保障   |
| pnpm exec vitest run packages/services/test/botsService.status.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix1-red.json | 1    | 原实现，9 tests：5 passed / 4 failed；前三个为提前关闭，第四个为 refresh 失败缺少日志。对应 fix1-red.log                         |
| 同一 status 命令，输出 fix1-green-status.json                                                                                                                                    | 0    | 首次 owner 补丁，9/9；此时尚未新增群订阅晚到回归                                                                                 |
| 同一 status 命令，输出 fix1-recovery-red.json                                                                                                                                    | 1    | 首补丁 + connection 回归，9 passed / 1 failed；证明仅 await startup 不足                                                         |
| 同一 status 命令，输出 fix1-recovery-red-2.json                                                                                                                                  | 1    | 首补丁 + connection/task-service 两回归，9 passed / 2 failed                                                                     |
| pnpm exec oxfmt packages/services/src/bots/botsService.ts packages/services/test/botsService.status.test.ts；fix1-format-write.log                                               | 0    | 仅格式化本次两个变更文件                                                                                                         |
| 下列 focused 命令；fix1-green-focused.json / .log                                                                                                                                | 0    | 3 文件 34/34：status 11/11（原5 + 新6），botsChannelRuntime 21/21，composition 2/2                                               |
| 下列原 12 文件命令；fix1-green-final-12.json / .log                                                                                                                              | 0    | 12 文件 78/78；未混入独立 R3 计数测试                                                                                            |
| 下列 recovery 兼容命令；fix1-green-recovery.json / .log                                                                                                                          | 0    | 2 文件 126/126：groups 112/112，privateSync 14/14；因本次修改最终订阅提交点 guard 扩展这些实际相关场景，未机械重跑所有 Bots 套件 |
| pnpm architecture:check --changed；fix1-architecture-after.log                                                                                                                   | 0    | violations 0 / baseline 0 / new 0                                                                                                |
| pnpm exec oxlint packages/services/src/bots/botsService.ts packages/services/test/botsService.status.test.ts；fix1-lint.log                                                      | 0    | 2 文件，0 warning / 0 error                                                                                                      |
| pnpm exec oxfmt --check packages/services/src/bots/botsService.ts packages/services/test/botsService.status.test.ts；fix1-format-check.log                                       | 0    | 两个变更文件格式通过                                                                                                             |
| git diff --check；fix1-diff-check.log                                                                                                                                            | 0    | 无差异空白错误                                                                                                                   |

```powershell
pnpm exec vitest run packages/services/test/botsService.status.test.ts packages/services/test/botsChannelRuntime.test.ts packages/services/test/conversationShareComposition.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix1-green-focused.json
pnpm exec vitest run packages/client/test/remoteServiceAccess.test.ts packages/desktop/test/hostRemoteWorkspaceServices.test.ts packages/desktop/test/remoteConversationShareWiring.test.ts packages/desktop/test/remoteWorkspaceSessionServices.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/servicesEntryBoundary.test.ts packages/services/test/telemetryUserIdLoader.test.ts packages/shared/test/officialMcpAuthProtocol.test.ts packages/zcode-server-cli/test/coreHttp.test.ts packages/services/test/credentialService.test.ts packages/services/test/standaloneProviderRuntime.test.ts packages/shared/test/mcp.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix1-green-final-12.json
pnpm exec vitest run packages/services/test/botsService.groups.test.ts packages/services/test/botsService.privateSync.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix1-green-recovery.json
```

## 自审、边界与剩余关注

- 已读取本次两个文件的完整 scoped diff；所有新增回归均有原实现或首补丁 RED，不用首次偶然通过代替最终结果。startup 关闭等待与订阅提交 guard 都有实际触发覆盖，未更改 authorityMode、删除清理、增加超时/skip、吞掉新初始化错误或恢复退役商业服务。
- 不修改 channelRuntime.ts 或三个 Provider runtime；Service 级真实 startup 引用足以覆盖本次已接纳任务，无需扩大底层队列合同。
- 已覆盖实际相关正常群聊与私聊恢复、三类 runtime 现有释放和 composition。临时目录锁清理仍走原 await asyncDispose → rm，不加任何额外锁等待、定时等待或重试。
- 原 R3 的旧频道 46 计数不在本次 Fix1 范围，也没有被声明通过。原 EPERM 日志完整保留；修复后的精确 composition 2/2 和原 12 文件 78/78 作为新运行事实。
- pnpm 仍提示仓库已有 package.json pnpm 字段忽略信息，Git 仍有 LF/CRLF 提示；oxlint 自身 0 warning / 0 error，不声称全程输出完全无噪声。
- 根 typecheck/lint、29 规格及完整原始基线 pre-push 仍由 controller 整批统一执行，本次未运行全量 pnpm test/test:unit，也未 push。Task4 本地必要回归与 I1 验收已通过，发布总门禁仍以 controller 最终结果为准。

# Task 4 Fix 2：初始化失败仍等待同次并行读取全部结束

状态：实施及定向验证完成，待 controller 唯一 scoped 复审。FIX_BASE 为 a1182730；开工时 HEAD 同为 a1182730。期间 controller 先提交 35bbee08，仅在 tracked spec/plan 明确失败路径合同。本轮实现仅修改 botsService.ts、botsService.status.test.ts 和本报告追加，不纳入其他任务改动，也不覆盖此前报告或原始失败日志。

## 独立复审结论与本轮根因证据

Fix1 独立复审 task-4-fix1-rereview.md 将 I1 判为 NOT ADDRESSED：Service 已持有 startupPromise，但 ensureBotStorageMigrated 内的 Promise.all 会在一个读取拒绝时提前拒绝，另一个已接纳读取仍可能在途，因此 shutdown 等待的 startupPromise 仍不足以证明本次 IO 全部结束。Fix1 的通过记录保留为历史运行事实，不能代替本轮失败路径验收。

本轮先将该场景迁为正式参数化回归，两方向均在修改生产代码前失败。每个用例分别等待 config/state 真实入场，关闭服务后才释放指定失败读取；同次兄弟读取继续由另一个 deferred 保持 pending。shutdown 自身 cancelUploads 的 readState 独立即时返回，不能成为 startup 读取的替代屏障。

| 正式回归 | 原 a1182730 + 新测试的 RED | 本轮最终 GREEN |
| --- | --- | --- |
| config 拒绝，state 仍在途 | fix2-red.json：ioFinished 为 false，但 disposed 已为 true；第 175 行 expected true to be false | status 13/13 中通过 |
| state 拒绝，config 仍在途 | 同一 RED，同一关闭提前完成断言失败 | status 13/13 中通过 |

RED 总计 13 条：11 passed / 2 failed，exit 1。两失败均为上述预期关闭断言，不是测试超时、导入错误或真实文件系统偶现失败。它们确定性证明 fail-fast 依赖是本次错误路径缺口；仍不声称已穷尽原单次 EPERM 的所有成因。

## 最小修复与保留合同

- 唯一生产变更位于 ensureBotStorageMigrated：将同次 repo.readConfig/readState 的两个原始 Promise 保存为局部 reads；成功路径仍由原 Promise.all 完成。失败 catch 先 await Promise.allSettled(reads)，再按原逻辑清空 botStorageMigrationPromise 并重抛原 error。
- 这使现有 startupPromise → shutdownPromise 的等待依赖完整覆盖已发出的兄弟读取。没有新增 pending 账本、生命周期 owner、公共 API、超时、重试或文件删除操作，也没有扩大 Provider runtime 的队列合同。
- 原 Promise.all 捕获的第一个拒绝对象直接重抛，没有从 allSettled 按数组顺序另选错误；初始化 error 和三个 startup refresh warn 保持原信息。双方向测试逐项验证这些日志、并发 dispose 返回同一 Promise，以及关闭后读取计数不再增长。
- 中文注释解释 fail-fast 后兄弟读取仍可能持有文件锁，因此关闭必须等待全部已接纳 IO 结束。authorityMode、composition 清理、退役账号/遥测/分享功能、Fix1 的恢复订阅 guard 均未改。

单次 setImmediate 仅让事件循环观察已可 settle 的关闭 Promise，并让三个已接纳 refresh 共享初始化；它不是 IO 完成屏障。读取入场和结束均由明确 deferred 控制，最终完成仍只验收原 disposeAllAndWait Promise。用例 finally 释放 deferred 并等待兄弟读取及关闭，不靠 sleep、固定次数微任务循环或 rm 重试。

## 执行命令与真实结果

全部从仓库根执行，固定 PATH 指向 Node 24.14.0，pnpm 10.33.2。原始输出位于 scratch/task-4/fix2-*，此前 red/green/EPERM 文件未覆盖。

| 命令 / 日志 | exit | 结果 |
| --- | --- | --- |
| node scripts/check-workspace-freshness.mjs | 0 | ahead 43 / behind 0，无远端跟踪分支提示 |
| pnpm architecture:check --changed；fix2-architecture-before.log | 0 | violations 0 / baseline 0 / new 0 |
| pnpm architecture:context services；fix2-services-context.log | 0 | services 当前为 legacy unmanaged，无额外已声明 contract；不将架构检查当作释放时序语义的证明 |
| 下列 status 命令，输出 fix2-red.json / .log | 1 | 生产修复前 13 条：11 passed / 2 failed，两个方向均提前完成关闭 |
| 同一 status 命令，输出 fix2-green-status.json / .log | 0 | 13/13 |
| pnpm exec oxfmt packages/services/src/bots/botsService.ts packages/services/test/botsService.status.test.ts；fix2-format.log | 0 | 仅格式化这两个变更文件 |
| 下列 focused 命令；fix2-green-focused.json / .log | 0 | 3 文件 36/36：status 13、botsChannelRuntime 21、composition 2 |
| 下列原 12 文件命令；fix2-green-final-12.json / .log | 0 | 12 文件 78/78，无 pending；未混入独立 R3 计数测试 |
| 下列恢复命令；fix2-green-recovery.json / .log | 0 | 2 文件 126/126：groups 112、privateSync 14；复验共享初始化依赖变更后的既有恢复合同 |
| pnpm architecture:check --changed；fix2-architecture-after.log | 0 | violations 0 / baseline 0 / new 0 |
| pnpm exec oxlint packages/services/src/bots/botsService.ts packages/services/test/botsService.status.test.ts；fix2-lint.log | 0 | 2 文件，0 warning / 0 error |
| pnpm exec oxfmt --check packages/services/src/bots/botsService.ts packages/services/test/botsService.status.test.ts；fix2-format-check.log | 0 | 两个变更文件格式通过 |
| git diff --check；fix2-diff-check.log | 0 | 无差异空白错误 |

```powershell
pnpm exec vitest run packages/services/test/botsService.status.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix2-red.json
pnpm exec vitest run packages/services/test/botsService.status.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix2-green-status.json
pnpm exec vitest run packages/services/test/botsService.status.test.ts packages/services/test/botsChannelRuntime.test.ts packages/services/test/conversationShareComposition.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix2-green-focused.json
pnpm exec vitest run packages/client/test/remoteServiceAccess.test.ts packages/desktop/test/hostRemoteWorkspaceServices.test.ts packages/desktop/test/remoteConversationShareWiring.test.ts packages/desktop/test/remoteWorkspaceSessionServices.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/servicesEntryBoundary.test.ts packages/services/test/telemetryUserIdLoader.test.ts packages/shared/test/officialMcpAuthProtocol.test.ts packages/zcode-server-cli/test/coreHttp.test.ts packages/services/test/credentialService.test.ts packages/services/test/standaloneProviderRuntime.test.ts packages/shared/test/mcp.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix2-green-final-12.json
pnpm exec vitest run packages/services/test/botsService.groups.test.ts packages/services/test/botsService.privateSync.test.ts --reporter=json --outputFile=.superpowers/sdd/2026-11-16-release-gate-repair/scratch/task-4/fix2-green-recovery.json
```

## 自审与 concerns

- 已逐行自审本轮两个源码/测试文件的完整 diff：生产修改仅局部等待依赖，测试仅新增两个错误方向；未修改 channelRuntime、三个 Provider runtime、authorityMode、清理或 timeout，未新增 skip，未恢复退役 surface。
- 两个单失败方向有正式 RED→GREEN。双读取同时拒绝未另加测试；原 first-rejection 的保留由同一 catch 参数及 throw error 直接保证，而 allSettled 只承担 drain。
- 原 R3 旧 46 频道计数仍不在本轮范围，不声明其通过。现有 pnpm 忽略 package.json 字段、Node SQLite experimental 和 Git LF/CRLF 提示仍保留在原日志中；定向 oxlint 自身为 0 warning / 0 error，不将输出噪声写成不存在。
- 根 pnpm typecheck、pnpm lint 与整批 pre-push 按 task brief 由 controller 统一执行，本轮未执行，不声明通过。未运行全量 pnpm test/test:unit，未 push。I1 的最终处置及发布门禁以 controller 对 a1182730..fixHEAD 的权威包和独立复审为准。
