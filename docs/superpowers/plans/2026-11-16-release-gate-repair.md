# 1.4.1 发布门禁补充修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户授权的 96 个既有失败断言与 3 个导入失败，通过真实发布门禁后继续原 1.4.1 发布与安装目标。

**Architecture:** 保持当前服务与状态所有者，先修已定位的测试环境隔离与 native path 夹具。其余失败按 owning source、当前产品合同和真实错误形成证据清单，再在对应实现开始前补充具体修复任务；不预判过期测试应恢复已退役产品能力。

**Tech Stack:** TypeScript、Vitest、Electron、pnpm 10.33.2、Node 24.14.0。

**Spec:** `docs/testing/1.4.1-gate-repair-spec.md`

## Global Constraints

- 全程中文；只在当前隔离分支工作，保留无关改动。
- 当前源码与 standalone/mobile-remote spec 决定产品边界，不恢复已退役的官方能力。
- 代码改动前运行架构检查；跨模块或所有者不清时读取架构 context。
- 不增加 skip、不降低断言强度、不扩大超时、不以全量跳过替代定向修复。
- Node 24.14.0、pnpm 10.33.2；保留真实 RED/GREEN、退出码与审查结果。
- 测试夹具控制并恢复自己的环境，不读取真实用户技能、配置或凭据。
- 不修改 owner/lease、workspaceIdentity、remoteSessionId 和 stale run 防护来迁就测试。
- 不 push、merge、发布或安装；由 controller 在全部必要验收后统一完成已授权发布流程。

### Task 1: 修复机器环境与本地路径测试隔离

**Files:**

- Modify/Test: `packages/services/test/skillsService.test.ts`
- Modify/Test: `packages/services/test/terminalService.test.ts`
- Modify/Test: `packages/services/src/project/contract.test.ts`
- Spec: `docs/testing/1.4.1-gate-repair-spec.md`
- Read: `packages/services/src/skills/skillsService.ts`、`packages/services/src/terminal/terminalService.ts` 与 project 目录现有实现/合同。

**Interfaces:**

- Consumes: `createSkillsService`、`createTerminalService`、`createProjectService` 的现有公开调用与测试夹具。
- Produces: 三个测试文件在 Windows 上独立运行通过，保留平台分支与临时目录隔离；不新增产品 API。

- [ ] **Step 1: 验证当前失败并记录依据。** 在固定 Node 下运行下列精确规格，写入本任务 scratch 日志；输出只摘录脱敏标题、断言差异和统计，不打印终端环境全量对象。

```powershell
pnpm exec vitest run packages/services/test/skillsService.test.ts packages/services/test/terminalService.test.ts packages/services/src/project/contract.test.ts --reporter=json --outputFile=<本任务 scratch>/task-1-red.json
```

RED 已复现 22 条失败：skills 20、terminal 1、project 1。源码纠正了最初的 HOME 假设：生产 `resolveUserHomeDir` 与测试 homedir mock 已优先 HOME；实际技能污染来自 Windows 临时目录向上发现了真实用户目录中的 `.git`，随后把该祖先工作区的 `.agents` 扫入结果。终端某用例在 Windows 仍断言 POSIX shell；project 本地路径断言未按平台 normalize。原始失败记录保留，不把初步假设记成确认根因。

- [ ] **Step 2: 收紧环境夹具。** 为每个临时 skills home 建立受控 `.git` 工作区边界，阻止发现真实祖先仓库；使用文件已有的环境保存/恢复模式隔离 HOME 与 USERPROFILE，确保 `vi.resetModules` 前即生效。增加或保留“用户技能仅来自本次临时 home”的断言。终端测试显式选择被测平台，保留 Windows PowerShell/cmd 与 POSIX 启动参数覆盖，并隔离 APPDATA、LOCALAPPDATA、XDG_CONFIG_HOME 等实际配置输入。不修改生产逻辑把 `/bin/sh` 强加给 Windows。

```ts
// 夹具使用临时 home；测试结束后恢复原始环境，防止读到操作者的真实技能。
process.env.HOME = home;
process.env.USERPROFILE = home;
```

上述是输入示例；若现有 resolver 还读取其他目录变量，必须按 owning source 同步控制和恢复。测试不输出环境对象。

- [ ] **Step 3: 修复本地路径期望。** 在 project 测试中用 `node:path` 的 `resolve`/`join` 构建本地绝对路径及规范化期望；仍验证 `relative` 拒绝、父级折叠、repository 零访问和未 admission。保留远端 POSIX `/remote` 转发用例不变。

```ts
const ownerPath = resolve("/owner");
expect(await service.readDirectory()).toEqual({ path: ownerPath, entries: [] });
```

- [ ] **Step 4: 定向 GREEN 与静态检查。** 重跑 Step 1 三规格并保留 JSON，运行变更文件格式检查、`git diff --check` 与架构检查。controller 在整批补充修复完成后执行根 typecheck/lint 与完整 affected；不得因此声称根检查已经通过。
- [ ] **Step 5: 自审、提交与报告。** 只提交三文件及确有必要的对应 spec 更新；报告每个根因、原断言保留情况、RED/GREEN 命令和统计、自审/concerns。若发现产品设计缺陷，报告具体证据，不能自行改产品合同。

### Task 2: 建立其余门禁的可执行根因清单

**Files:**

- Read: 旧完整报告与原始 main 对照 JSON、剩余 26 个失败规格及其直接 owning source。
- Create: 本计划 scratch 中的 `remaining-failure-inventory.md` 和结构化 `remaining-failure-inventory.json`。
- Modify: controller 根据清单，在本计划后续追加具体实施任务。

**Interfaces:**

- Consumes: 旧完整检查的真实失败标题与原始 main 复现证据，不重新跑全部门禁。
- Produces: 每规格的当前根因证据、产品/测试/环境分类、最小修复建议、精确源文件/spec、必要验证与分组依赖。未知根因明确列出下一条聚焦命令，不猜测。

- [ ] **Step 1: 从原始对照 JSON 提取失败规格与标题。** 去重后排除 Task 1 的三个规格与已修 FR-I1；原始报告只读，保留历史结论。
- [ ] **Step 2: 核对每个失败与当前源代码。** 对导入不存在的符号查当前公开入口与退役合同；对 mobile/remote 分清原厂远控与用户自托管 attachment；对异步失败核 owner、事件顺序与 mock ACK 合同。禁止将所有 remote 失败视作退役。
- [ ] **Step 3: 输出证据矩阵。** 每行包含规格、失败数量/标题、直接错误、源文件与行、spec 依据、确认程度、最小修复和精确验证命令；不打印秘密或真实内部地址。
- [ ] **Step 4: 提供后续实施分组。** 同 owner/同形小修成一组；需要单独产品判断、测试周期与 review 的单独成组。清单是调查交付，不作为源码已修或门禁通过证据。

### Task 3: 修复 Windows 失效资源锁回收

**Files:**

- Modify: `packages/desktop/src/host/sourceServerReleaseResolver.ts`
- Test: `packages/desktop/test/sourceServerReleaseResolver.test.ts`
- Spec: `docs/desktop/standalone-coding-harness-spec.md` 的资源缓存锁合同。

**Interfaces:**

- Consumes: 现有 `resolveSourceServerReleaseAsset` 公开入口、`.lock/owner.json` 与独占 `.reaping` 标记；不改变其签名和缓存身份。
- Produces: Windows 可安全回收已退出进程的锁；现有 SHA、互斥、取消与清理边界保持。本任务只关闭句柄导致的 EPERM；同规格另两条“中断回收提示完整路径”与通用脱敏出口的合同冲突继续作为补充修复必做项，不把本任务通过外推为整个规格或门禁全绿。

- [ ] **Step 1: 定向 RED。** 固定 Node 下运行现有“回收已退出进程的锁后可以重新下载”规格并记录 `rename` 的 EPERM 与源位置；若原始错误已不出现，核对文件状态及真实平台，不通过猜测修改。

```powershell
pnpm exec vitest run packages/desktop/test/sourceServerReleaseResolver.test.ts -t '回收已退出进程的锁后可以重新下载' --reporter=json --outputFile=<本任务 scratch>/task-3-red.json
```

- [ ] **Step 2: 最小句柄生命周期修复。** 在 `reclaimExitedLock` 中确保 `.reaping` 内容完成写入并关闭文件句柄，再进行旧 owner/token 复核和 `rename(lockDir, retiredLockDir)`。使用 `try/finally` 保证写入失败也关闭句柄；保留磁盘标记作为回收互斥，不能为了重命名先删除标记。保留原 owner 存活、token 不匹配与中断回收提示，不扩大重试或超时。以中文注释解释 Windows 打开句柄阻止父目录重命名的根因。

```ts
try {
  await reaper.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
} finally {
  await reaper.close();
}
// 在保留.reaping互斥标记的前提下，再复核owner并执行原子重命名。
```

上例只说明顺序；须与原 `retiredLockDir` finally 清理组合，避免漏关句柄、双重关闭或清理后来者的新锁。

- [ ] **Step 3: GREEN 与并发边界。** 运行整个精确测试文件，保留失败锁回收、遗留回收标记两分支、同SHA并发只下载一次、不同SHA不覆盖、校验失败清理、取消后重试覆盖。增加聚焦回归：两个并发请求竞争同一个已退出 owner 锁，最终只下载一次并只剩当前归档；原实现下应暴露 Windows 回收失败，不用增加 sleep 或放宽时限。新并发及原单独回收断言须 GREEN；全文件预期仍有两条已确认的提示脱敏合同失败，必须逐项报告并继续后续任务，不能改成 skip、移除、降低要求或宣称全文件通过。

```powershell
pnpm exec vitest run packages/desktop/test/sourceServerReleaseResolver.test.ts --reporter=json --outputFile=<本任务 scratch>/task-3-after.json
```

- [ ] **Step 4: 架构、格式与提交。** 修改前执行架构检查，阅读已有 resolver 与当前 spec，属于局部既有合同修复无需制造新模块；修改后重跑架构、定向格式与diff检查。自审后只提交本任务源码/测试/对应spec，完整报告写本计划scratch，controller独立派任务审查。根typecheck/lint在整批后执行。

### Task 4: 迁移已退役商业服务的测试边界

**Files（仅测试，不恢复生产功能）:**

| 文件                                                           | 具体迁移与保留验收                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/client/test/remoteServiceAccess.test.ts`             | client-config 旧读取 case 改为保留的 ProviderSettings RPC 调用；Source management 可选与 window-project 显式能力用例保留；确认不构造 client-config 频道。                    |
| `packages/desktop/test/hostRemoteWorkspaceServices.test.ts`    | 删除旧订阅/client-config 标识与注入；保留所有真实远端执行服务、模型/Provider 所有者、普通凭据、本地控制端分组与广播边界。                                                    |
| `packages/desktop/test/remoteConversationShareWiring.test.ts`  | 不再导入已删除 attachment Share wrapper；改验证当前远端服务装配不发布 conversation-share、普通文件/会话服务仍来自 Source；覆盖 SSH/WSL/Docker/server，不能要求已删 wrapper。 |
| `packages/desktop/test/remoteWorkspaceSessionServices.test.ts` | 移除虚构 conversationShareService fixture 及对应 remote override 断言；保留现有 file/hooks/Provider 远端覆盖与普通全局服务本地 fallback、真实 RPC 闭环。                     |
| `packages/services/test/conversationShareComposition.test.ts`  | 迁为当前 createLocalServices 装配不含云发布服务，保留普通模型视图与 desktop-attached-remote 的权威模式差异；保留异步 dispose 与独立配置夹具。                                |
| `packages/services/test/servicesEntryBoundary.test.ts`         | root/node 入口均不再导出官方 Share interface/runtime/error/mock；同时对实际仍存在的 Node-only 服务检查 browser-safe 边界，不能整文件删除。                                   |
| `packages/services/test/telemetryUserIdLoader.test.ts`         | 验证不再导出/装配旧账号遥测 loader；原“凭据解密失败不删除存量凭据”有独立价值，迁到现有 credential suite，使用临时密文夹具而非恢复旧遥测调用。                                |
| `packages/shared/test/officialMcpAuthProtocol.test.ts`         | 改为拒绝已退役官方身份注入协议/声明的边界验收；普通 MCP HTTP/OAuth 协议继续由 `packages/shared/test/mcp.test.ts` 的正向用例验证。                                            |
| `packages/zcode-server-cli/test/coreHttp.test.ts`              | Share 专属 case 改测当前未注册该频道；保留 Host capability/普通 Web 不可伪造/Provisioning 真实 RPC 安全边界，不再装配官方发布服务。                                          |
| `packages/services/test/credentialService.test.ts`             | 仅在缺少通用覆盖时迁入前述解密失败不删除凭据断言，设置本次临时目录，结束后恢复环境；不读真实凭据。                                                                           |

**Interfaces:**

- Consumes: 当前 services root/node 公开入口、RemoteServiceAccess、远端 service collection、Core HTTP 与 MCP schema 的既有合同。依据 `docs/desktop/standalone-coding-harness-spec.md` 的退役/数据保留规则与 Task 2 清单 R1 对应条目。
- Produces: 九个原失败规格迁到当前产品边界；迁入普通凭据与保留能力有实际定向运行证据。旧文件名可暂保留作为退役合同测试，不新增生产导出、兼容空实现或 mock 出不存在的模块。

- [ ] **Step 1: RED 与直接 owning source。** 固定 Node 运行九个精确旧规格，JSON/原始日志写本任务 scratch；记录失败标题与导入错误，核当前公开入口/spec。不要将找不到测试文件当作成功，不使用 passWithNoTests。
- [ ] **Step 2: 按表逐项迁移夹具和断言。** 对退出的公开 surface 用动态 namespace 的存在性验证；对保留功能使用真实 service 注册、RPC 或现有转换函数，不仅修改测试标题。例：

```ts
const [rootEntry, nodeEntry] = await Promise.all([
  import("@zcode/services"),
  import("@zcode/services/node"),
]);
for (const entry of [rootEntry, nodeEntry]) {
  expect(entry).not.toHaveProperty("IConversationShareService");
  expect(entry).not.toHaveProperty("ConversationShareService");
}
```

上述负向断言配合表内普通服务和 RPC 正向验收，不能作为删除整个混合 suite 的理由。若当前生产装配不符合既有退役合同，报告具体证据，controller 单列源码任务；本任务不制造新生产 API。

- [ ] **Step 3: GREEN 与迁入验证。** 运行上述九规格，加上 `packages/services/test/credentialService.test.ts`、`packages/services/test/standaloneProviderRuntime.test.ts`、`packages/shared/test/mcp.test.ts`、`packages/desktop/test/windowHostAttachmentRpcPolicy.test.ts`。最后一个规格的旧 46 数字计数已知另有 R3 任务，若仍失败保留明确独立结果；本任务新增/迁移断言与其余保留 suite 必须实际通过。不触碰其计数、不新增 skip、不修改 timeout。迁入历史读取由 standaloneProviderRuntime 的 `getImportedConversation` 正向/缺失用例覆盖，不恢复云 API。
- [ ] **Step 4: 静态、自审与提交。** 修改前后运行架构检查、变更测试文件格式/diff 检查。报告逐文件旧失败→新覆盖/原保留覆盖映射、真实命令与统计、潜在未覆盖边界，并只提交本任务测试/必要 spec；独立 controller 派审。真实 UI 未变不为本任务额外添加 E2E；根类型/lint 与完整门禁仍在整批结束执行。

### Task 5: 修正原平台豁免 API 与原生资源路径断言

**Files:**

- Modify/Test: `packages/desktop/test/remoteWorkspacePreparation.test.ts`
- Modify/Test: `packages/zcode-server-cli/test/remoteAssetRelease.test.ts`
- Read: `packages/desktop/src/host/remoteWorkspacePreparation.ts`、`packages/zcode-server-cli/src/packaging/remoteAssetRelease.ts`。

**Interfaces:**

- Consumes: 当前目录 admission 与四平台 release asset staging 公开入口。
- Produces: 原本应豁免的平台权限组合正确跳过，删除目录场景仍在 Windows 实跑；四归档文件名以 native basename 验证，生产代码不变。

- [ ] **Step 1: RED。** 精确运行两文件并保留结果，确认 `context.skip` 不是合法参数、原生分隔符比较差异来自旧测试；不把 Windows chmod 语义当成生产 admission 缺陷。

```powershell
pnpm exec vitest run packages/desktop/test/remoteWorkspacePreparation.test.ts packages/zcode-server-cli/test/remoteAssetRelease.test.ts --reporter=json --outputFile=<本任务 scratch>/task-5-red.json
```

- [ ] **Step 2: 修正夹具。** 原 `it.each` 第二回调参数不是 Vitest `TestContext`，将 Windows/root 且 `mode !== null` 的原有运行时豁免改为静态 `it.skipIf`/逐组合构造，准确保持原计划豁免集合；`mode === null` 的 manual/automatic 删除目录与修复重连用例必须在 Windows 执行。POSIX CI 非 root 权限组合仍执行，不新增豁免条件。文件名比较复用 `node:path.basename`，保留四目标、descriptor、size/SHA 与缺失 fail closed 断言。

```ts
// 只更换路径解析方法，不更换预期四平台归档名集合。
const fileNames = copiedPaths.map((filePath) => basename(filePath));
```

实际变量名按当前测试；不得用仅检查数组长度代替精确文件名集合。

- [ ] **Step 3: GREEN。** 重跑两文件，报告每个执行/跳过的参数组合与原意的对应；Windows/root 权限豁免必须如实计入skip且说明是修正既有豁免API，不能写成所有权限分支实测通过。
- [ ] **Step 4: 静态、自审、提交。** 架构before/after、变更文件格式/diff检查，报告真实命令与统计，只提交两测试文件。controller独立派审；无需改产品spec或生产实现，也不改全局Vitest配置触发全量跳过。

### Task 6: 定位三条 stale plugin/MCP 异步失败

**Files:**

- Read/Test: `packages/services/test/zcodeAgentService.test.ts`
- Read: `packages/services/src/zcode-agent/zcodeAgentService.ts`、该规格 fake Agent 与直接 process manager/transport 依赖。
- Create: 本计划 scratch 的 `task-6-report.md` 与脱敏、有序诊断证据；不修改源码、正式测试、spec、index 或 HEAD。

**Interfaces:**

- Consumes: Task 2 标为未确认的三条失败、当前 plugin/mcp-status lane 及 watchdog 合同。
- Produces: 每条失败的首个未满足事件/ACK、实际请求与 process exit/retry 顺序、确认根因或明确证据缺口，以及可独立实施的最小后续任务建议。

- [ ] **Step 1: 聚焦原失败。** 固定 Node 下只选择三条 stale/watchdog 用例；不要把另 11 条缺少 refreshRegistry ACK 的 native create/send 根因套到这三条。

```powershell
pnpm exec vitest run packages/services/test/zcodeAgentService.test.ts -t 'restarts a stale protocol client|mcp/list 超时触发' --reporter=json --outputFile=<本任务 scratch>/task-6-focused.json
```

- [ ] **Step 2: 建立有序证据。** 核对 fake 请求处理器、真实 lane admission、超时/watchdog 回收及重试前初始化的严格协议；必要时用明确命名的临时复现夹具记录请求/响应/exit 事件到 scratch，结束后清理该任务创建的临时文件。禁止打印完整环境/凭据、扩大超时或改变正式实现来“诊断通过”。不能靠固定 sleep 推断 ready。
- [ ] **Step 3: 输出每条根因。** 报告明确 fake 是否漏 ACK/响应 schema、产品是否错误选择 lane、旧 generation 是否误回收新 client、以及插件进程是否受到 MCP 回收影响。给出源位置、最小修复文件、应保留断言与精确后续验证，不在本调查改产品或正式测试。
- [ ] **Step 4: 交付。** 写真实命令/exit/结果与确认程度，最终短回复报告路径与结论；controller独立审查调查后才为代码修复追加 brief。本任务可以与 Task 4 夹具迁移并行调查，两者不共享写入文件，也不进行 dist 构建。

### Task 7: 对齐手机频道与 Provisioning 触发器的精确合同

**Files:**

- Modify/Test: `packages/desktop/test/windowHostAttachmentRpcPolicy.test.ts`
- Modify/Test: `packages/shared/test/windowHostControlProtocol.test.ts`
- Modify（仅清理已退役 Share wrapper 注释）: `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts`
- Read: `packages/shared/src/provider-provisioning.ts`、`packages/shared/src/validation.ts`、standalone/mobile-remote spec。

**Interfaces:** 当前 mobile exposure allowlist 和严格 Host 消息 schema 是既有唯一 owner；不扩大手机权限，不修改 schema、不恢复官方触发器。

- [ ] **Step 1: 精确 RED。** 固定 Node 运行两个测试文件，保存旧 46 计数和 `credential` 正向触发器失败证据。
- [ ] **Step 2: 频道集合验收。** 将旧数字改成独立写明的精确集合比较，预期 ServiceChannels 成员为：File、MediaPreview、System、Git、GitCheckpoint、Setting、OnboardingRecord、Credential、CuaPermission、CuaPipSession、Broadcast、ZCodeTask、WindowController、ZCodeAgent、ZCodeSession、Project、TaskGroups、RemoteProjects、WindowProject、WindowRemoteProjects、WindowProjectChanges、FileWatcher、ProviderSettings、ModelSelection、SourceServerWorkspace、UsageStats、Skills、SkillSync、McpSync、PluginSync、Plugins、PluginManagement、Subagents、Commands、Hooks、Memory、OutputStyle、SettingsSync、Bots、PromptAttachmentTransfer。比较排序后的完整集合；不能从被测集合导出预期。保留 Terminal、SourceServerManagement、ProviderProvisioningTarget、未来未知频道拒绝，desktop 全服务面和真实 RPC 拒绝/允许用例。生产文件仅删已不存在的 Share wrapper 注释，不修改权限。
- [ ] **Step 3: 触发器验收。** SourceChanged 正向分别覆盖 `personal-config`、`configured-default`，负向覆盖 `credential`、`account-settings`、`environment-online`。Execute 仍允许 `environment-online`，保留 scope、非空身份、未知字段严格拒绝及执行结果断言，不放宽 schema。
- [ ] **Step 4: GREEN/静态/提交。** 重跑两个精确文件；修改前后架构检查，变更文件格式、diff 检查。报告完整集合、正负协议分支与真实统计，自审后仅提交本任务三文件；controller 独立任务审查，根 typecheck/lint 最终统一执行。

### Task 8: 修复普通 Provider 首次升级的模板关联与测试观察器

**Files:**

- Modify: `packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts`
- Modify/Test: `packages/services/test/legacyProviderUpgrade.test.ts`
- Modify/Test: `packages/services/test/legacyPersonalProviderConfigImporter.test.ts`
- Modify: `packages/desktop/test/e2e/helpers/desktop-app.ts`
- Test: `packages/desktop/test/customOpenAIProviderStore.test.ts`
- Spec: `docs/desktop/standalone-coding-harness-spec.md` 的首次升级合同。
- Read: 当前 `config/provider/zcode-builtin.json`、`packages/shared/src/legacy-model-provider-identity.ts`、`packages/shared/src/model-provider-types.ts`、Provider access 公开类型/谓词。

**Interfaces:** Personal Repository 独占首次导入及持久化；importer 只输出规则，Resolver 消费当前随包模板。E2E helper 只观察既有 Personal 文件，不引入产品写入或账号依赖。

- [ ] **Step 1: RED 与当前模型合同。** 固定 Node 精确运行三个测试文件（两 services 加 customOpenAIProviderStore），保存失败统计。核实当前随包 templateRules 真正 ID；旧稳定 Provider ID 与模板 ID 同名的假设已失效，不能仅改断言使不可执行 Provider 过关。
- [ ] **Step 2: 拆开稳定身份与模板关联。** importer 将旧 `builtin:bigmodel` 映射到 providerId=`bigmodel-api`、templateId=`bigmodel-standard-api`，旧 `builtin:zai` 映射到 providerId=`zai-api`、templateId=`zai-standard-api`。不修改共享 `BUILTIN_PROVIDER_TEMPLATE_IDS` 或旧选择迁移函数来改写稳定 Provider ID；在导入边界明确两个字段。只迁非空 Key，保留自定义 Provider、启停、成员及 context 意图；不导入官方账号、旧端点/模型名单或套餐。中文注释说明同一变量同时充当 Provider/模板身份导致当前模板解析丢失的根因。
- [ ] **Step 3: 回归真实解析。** 更新直接 importer 合同断言，并使升级集成测试使用当前随包模板，分别精确验证稳定 ID、当前 templateId、真实模板端点、GLM-5.3 可执行、四种启停、空 Key 不可执行、后续编辑/删除不再导入、旧 config.json 原文不变。新增/改动测试须先展示旧实现 RED，再改实现；不依靠 undefined===undefined 的端点比较。
- [ ] **Step 4: 观察手动 Key 兼容。** E2E helper 使用 Provider 包现有公开类型/谓词识别普通 api-key 与存量 `zhipu-coding-plan-api-key` 两种手动 Key；仍将账号等非手动 Key 投影为空，不恢复账号注入。保留现有普通 seed、旧文件不读取与兼容 Key 回归；不输出 Key，报告仅脱敏统计。
- [ ] **Step 5: GREEN/静态/提交。** 精确重跑三文件，修改前后架构检查；跨 services/provider 边界先读取各 owning context，变更文件格式/diff及定向 lint。报告修复前后、真实命令与统计，只提交本任务文件/必要 spec；独立任务审查。测试 helper 行为无产品 UI 变化，不额外制造 UI E2E。

## 后续执行规则

Task 2 结果形成后，controller 在任何后续代码修改前把有证据支持的具体实施任务写入本文、检查共享文件/接口冲突并生成独立 brief。Task 1 与 Task 2 分别为已定位夹具修复和只读调查，可并行；同时最多一个源码实施者。所有修复完成后执行根 typecheck/lint、架构、29 规格定向检查与原始基线的完整 pre-push，再进行一次补充差异整体审查。旧 FR-I1 的关闭结果不重做。
