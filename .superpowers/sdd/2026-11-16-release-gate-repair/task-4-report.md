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
