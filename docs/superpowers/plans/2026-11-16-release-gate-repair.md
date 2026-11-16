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

#### Task 4 Fix 1：关闭已暴露的 Bot 启动/释放验收缺口

独立审查 I1 确认迁移本身合规，但最终 composition 清理 EPERM 阻塞 GREEN。原“仅测试”限制在本次 fix 增加以下有界例外，先由可控生命周期回归验证根因，再修已有 owner；不能靠改变authorityMode、删清理或重试掩盖。

- Additional Modify: `packages/services/src/bots/botsService.ts`；仅确有证据时修改 `channelRuntime.ts` 与三个 Provider runtime 的既有关闭路径，不增加公共产品API。
- Additional Test: 复用 `packages/services/test/botsService.status.test.ts` / `botsService.fixtures.ts` 与 `botsChannelRuntime.test.ts` 的当前 fixture，选择覆盖实际改动的最小文件；不机械重跑所有Bots大套件。
- Spec: `docs/testing/1.4.1-gate-repair-spec.md` 的服务释放边界（已先补owner/时序）。
- [ ] **Fix 1.1: 确定性 RED。** 空受控Bot配置、deferred Repo读取/初始化，在startup已经接纳但IO未完成时调用disposeAllAndWait；验证原实现提前完成/仍能晚到读写。以明确入场信号、deferred释放和原关闭Promise观测，不用sleep/固定微任务次数/真实轮询网络。原单次EPERM不是唯一根因证明，报告分清静态候选与新RED。
- [ ] **Fix 1.2: 最小所有者收口。** 复用Bots Service现有shutdown Promise和启动的真实Promise引用，失效恢复后等待已接纳startup refresh/初始化/continuation完成；如需runtime刷新队列drain，扩展现有队列的完成合同而非另建计时状态。并发dispose同一Promise，晚到初始化不能重启后台runtime，不产生unhandled rejection；中文注释解释文件锁清理竞争。不要吞新增错误来伪造初始化成功。
- [ ] **Fix 1.3: GREEN。** 新确定性回归、实际覆盖的Bots释放规格通过；重跑composition精确文件及原Task4最终12文件批次，全部通过（独立R3仍另列不混入该批）。保留原EPERM日志，不用首次通过覆盖复跑失败。
- [ ] **Fix 1.4: 静态/报告/提交。** 架构before/after、services当前context、定向format/lint/diff；完整fix报告追加原task-4-report.md，含命令、输出与覆盖测试。原实施者修复后controller按215107a2..fixHEAD唯一scoped复审I1及fix新增破坏；R3不在本次fix范围。

#### Task 4 Fix 2：失败路径的兄弟 IO 完成合同

Fix1 scoped 复审的原 I1 仍开放：初始化并行读取使用 fail-fast `Promise.all`，任一读取拒绝后，startup 聚合可先于另一项已接纳读取完成，导致 shutdown 提前 settle。按现有服务释放合同，最小修直接初始化依赖的等待语义，保持错误可见性、唯一 shutdown owner 和 dispose 幂等。先以 config 失败/state 在途和相反方向的受控 deferred 回归证明 RED，再修复、运行实际覆盖测试和 Task4 原最终12文件 GREEN。不得改变 authorityMode、删除清理、增加 sleep、重试或超时。FIX_BASE 为 `a1182730`；完整修复报告追加 Task4，独立 scoped 复审原 I1 及本 fix 新破坏。

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

### Task 9: 迁移其余退役入口、更新桥与普通模型投影测试

**Files:**

- Remove（有效边界迁入下列 gateway suite）: `packages/client/test/webRemoteControlWindowDirectoryReadiness.test.ts`、`packages/desktop/test/webRemoteControlStatusEvents.test.ts`
- Modify/Test: `packages/desktop/test/mobileRemoteGateway.test.ts`
- Modify/Test: `packages/desktop/test/preloadDisposer.test.ts`
- Modify/Test: `packages/shared/test/processResourceTelemetry.test.ts`
- Modify/Test: `packages/ui/test/modelSelectionGroups.test.ts`
- Test: `packages/desktop/test/desktopPlatformUpdates.test.ts`、`packages/shared/test/process-diagnostic.test.ts`、`packages/services/test/standaloneProviderRuntime.test.ts`
- Read: 当前 mobile client `connect.ts`/`contract.ts`、mobile gateway、preload 更新桥及 standalone/mobile/GitHub update spec。

**Interfaces:** 只迁移测试到现有产品入口，无生产行为变更。手机是用户自托管 Noise 通道，窗口 Host 管 attachment；更新快照由 Main `getUpdateState` 管理，preload 只转发 `onUpdateState` 事件。

- [ ] **Step 1: 精确 RED。** 运行原五个失败规格，保存两个导入失败及旧更新/文档/账号 UI 断言失败；不得 mock 不存在的旧模块。
- [ ] **Step 2: 手机入口迁移。** 移除两个只针对已删除原厂 helper 的测试文件，逐项写出旧→新覆盖映射。现有 gateway suite 保留真实中继/加密/RPC、设备撤销断连接、窗口关闭、重连等测试；增加 Initialize 接收端创建先于 attach/Host 输出、窗口目录已就绪后选窗口、明确不存在的窗口不创建 Host attachment 三个当前合同验收。复用现有 relay/Noise 夹具和公开 `connectMobileRemoteLink`，不恢复旧 frame ACK/replay helper、原厂 relay 或跨 SSH 手机切换。原取消/迟到“不得发布过期服务”对应现 client 的 pending chooseWindow：在受控远端关闭后才完成选择，验证不会创建 attachment/返回成功；以明确关闭事件同步，不增加 sleep。旧重放机制已退役，当前断线以新链路重连覆盖，不制造等价旧协议。现有选窗/撤销与状态断言要明确指向目标窗口，不把旧 IPC status sender 改名恢复。
- [ ] **Step 3: 当前更新 bridge。** 把旧 onUpdateReady disposer 覆盖迁到 `onUpdateState`/`PlatformChannels.UpdateState`，实测后续消息停止触发且 removeListener 精确匹配；快照验证 `getUpdateState` 返回 Main 响应，preload 不缓存或立即回放旧状态。断言已退役 onUpdateReady/onUpdateStateChanged/onPostUpdateReleaseNotes/ack 接口不在实际暴露桥中，保留原混合 suite 的其他 IPC disposer。运行 desktopPlatformUpdates 的命令/订阅透传覆盖。
- [ ] **Step 4: 文档与普通 Provider。** 只替换 processResourceTelemetry 的退役 ARMS 文档属性表要求：文档明确 retired，旧共享兼容纯校验测试保留，另运行 process-diagnostic 对本地异常诊断正负协议验收，不恢复上报器。modelSelectionGroups 旧账号 Team 用例改为 Registry 普通 Personal Provider 自定义名称、API badge、完整原模型成员投影；不按 Family 重裁，不恢复账号 badge/directItems。旧账号历史不可执行另由 standaloneProviderRuntime 覆盖。
- [ ] **Step 5: GREEN/静态/提交。** 精确运行所有保留/迁入 suite，报告删除文件与实际新断言/旧保留断言的逐项映射，不能把缺测试当通过。架构 before/after、变更文件格式/diff/定向 lint；无生产交互变化无需新 UI E2E。独立任务审查后 controller 统一根门禁。

### Task 10: 迁移文件树的旧手机切换夹具

**Files:**

- Modify/Test: `packages/ui/test/projectFileNavigation.test.ts`
- Modify/Test: `packages/ui/test/projectFileTree.test.ts`
- Read: `packages/ui/src/project-sidebar/project-file-navigation.ts`、`useProjectFileTree.ts`、`remote-navigation.ts` 与 mobile-remote spec。

**Interfaces:** 现有 project-sidebar 解析器仅通过已绑定 identity session 或现有 desktop connector 访问远端；hook 的 request generation 是异步打开文件树唯一过期保护。无生产改动，不恢复 webRemoteControlWorkspaceSwitcher。

- [ ] **Step 1: 精确 RED。** 运行两文件，保留旧 switchWorkspace 从未被当前 owner 调用导致的三条失败证据。
- [ ] **Step 2: 当前入口验收。** navigation 旧 mobile switch 用例替换为绑定 identity session 的目标返回和未绑定无 connector 的 fail-closed；保留本地同名路径不可借用、foreign root 零副作用、desktop 真实 connector/bind 精确参数。当前手机一期只 local-window attachment，不宣称新跨 SSH 能力。
- [ ] **Step 3: 真正异步 generation 验收。** 将旧 late task switch 用例迁为 hook `openFiles` 通过现有 remote connector 的受控延迟 Promise：连接请求发出后 unmount，再完成连接，断言不能重新打开；另覆盖更新一轮文件请求先完成时旧异步结果不得覆盖。旧 handoff 用例改为同窗口 identity 索引绑定后直接 `openTaskFiles`，无旧切换、无重复 metadata；未绑定拒绝且不能读取同路径本地文件。保留其他 task identity/已绑定/本地/混合场景。使用明确 deferred 完成信号，不固定 sleep、清空有效断言或改生产 timing。
- [ ] **Step 4: GREEN/静态/提交。** 重跑两文件并保留精确调用/拒绝/过期结果断言，架构 before/after、格式/diff/定向 lint。报告根因及三条旧断言去向，独立审查；本任务无产品行为修改不追加新 UI E2E。

### Task 11: 恢复浏览器反向 RPC 并修正 Agent 协议测试夹具

**Files:**

- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Modify/Test: `packages/services/test/zcodeAgentService.test.ts`
- Read: `zcodeAgentBrowserAmbientContext.ts` 的现有 Executor、shared browserList/browserExecute schema 与 result、providerRefreshRegistry result、Task6调查报告及审查。
- Spec: `docs/testing/1.4.1-gate-repair-spec.md` 的 Agent 协议回归边界；`docs/browser-use/2026-07-07-agent-host-main-channel-spec.md`。

**Interfaces:** 现有 browserControlExecutor 是唯一注入点；反向 router 恢复纯 RPC，不新建service、pending map、权限旁路或另一个browser owner。Native readiness 保持先刷新Registry后create；三条stale fake不漏ACK，不能改其生产timeout/retry。

- [ ] **Step 1: RED。** 浏览器 stdio 现有正向用例已有执行器0调用证据；先精确重现并补无执行器、非法params、executor错误/无效result的必要合同回归，保留全上下文/browsers shape验证。Native只选一个代表缺ACK用例验证阻塞；已有11条main失败不必再次等完。计时器污染已有Task6精确4用例RED和有序证据，不重做诊断。
- [ ] **Step 2: 当前schema路由。** 在既有 client.onRequest 恢复 interactionBrowserList/Execute 分派；输入和结果均使用shared严格schema。list包装 `{browsers}`，execute透传已验证result，保留browserId/generation与完整远端scope，不吞掉错误或让请求悬空；无executor走现有backend_unavailable合同。复用现有workspace默认语义及Main实际能力/隔离owner，不臆造与现有协议冲突的身份规则。中文注释说明router缺失导致合法反向请求落到method-not-found。不得修改普通ambient预算/收集或引入权限会话事件。
- [ ] **Step 3: 严格fake与生命周期。** 只为实际走native registry barrier的 SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT、RUNTIME_PREFERENCES_FAKE_AGENT、LEGACY_CREATE_PARAMS_FAKE_AGENT 及核实需要的同类fake补 `provider/refreshRegistry` 的 `{refreshed:true}` ACK，保留session参数、旧optional字段拒绝重试与runtime preference原断言。为fake timer用例在可能挂起的await前登记可靠teardown；失败时同样关闭并等待已创建的service/订阅，再恢复timer和删目录，不能仅afterEach useRealTimers后丢弃在途进程。清理保持幂等，不改生产watchdog/timeout，不加skip或sleep。
- [ ] **Step 4: GREEN。** 先跑Task6四用例顺序组合，然后完整 `packages/services/test/zcodeAgentService.test.ts`（原41例加新增回归）；所有原断言实跑通过才可关闭15个原失败，不把单独3条通过当修好。报告原有环境告警与真实统计，保留JSON/日志，不输出协议中的环境/Key。
- [ ] **Step 5: 静态/自审/提交。** 架构before/after，目标模块当前context、定向格式/lint/diff；完整报告写task-11-report.md，独立任务审查。无产品UI修改不制造新UI E2E；不构建dist、不改共享schema、不恢复退役账号。

### Task 12: 修复 Source 自动重连的 Desktop attachment 恢复

**Files:**

- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Modify/Test: `packages/desktop/test/desktopRemoteSessions.test.ts`
- Spec: `docs/remote/provider-provisioning.md`、`docs/desktop/standalone-coding-harness-spec.md`（实现前补准确owner/ACK时序图）。
- Read: 原 Task2 清单 R4、mobile-remote spec、现有 attachRendererPort/confirmRendererAttachmentReady、相关Host消息schema及renderer接线。

**Interfaces:** Main只拥有请求/descriptor/转发route，不接管Host会话事实；复用唯一attachRendererPort和renderer ACK提交点。重连与首次连接的Provisioning屏障不同。

- [ ] **Step 1: 精确RED及旧遥测迁移。** 现15失败逐标题映射；去除已退役getRemoteConnectionStats/telemetry callback专属夹具与断言，但保留连接ready、同session错target不替owner、renderer ACK、dispose幂等、target与scope隔离。旧统计专属case须迁到其真实连接生命周期断言而非整段删除。旧官方remoteControl.replaceRemoteSession桥不恢复；保留合法mobileOnly scope join/cancel与桌面adoption，手机一期local窗口合同不扩展跨SSH。
- [ ] **Step 2: spec先行与回归。** 明确route从旧session换到新session、同步dispose旧Provisioning登记并登记新session；异步environment-online重下发与Desktop attachment恢复并行。添加/调整严格受控ACK回归：新port在对应renderer ACK后提升并拆旧port，随后通知RemoteSessionReconnected；迟到旧ACK/两次连续重连/关闭或Host退出不能通知或提升旧candidate。未完成或失败的Provisioning不能阻塞已重连Desktop；首次连接原屏障不变；mobileOnly不自动建desktop-continuous。
- [ ] **Step 3: 最小恢复实现。** 重连使用现有attachRendererPort，不复制owner/pending系统。消息传递遵守当前平台schema；attachment失败与过期结果有明确清理/日志，不能吞掉恢复失败或误拆更新后的route。中文注释解释原handleReconnected只改descriptor/Provisioning而未重新attach。不要固定微任务次数、sleep或放宽waitFor。
- [ ] **Step 4: GREEN与边界。** 完整desktopRemoteSessions文件加mobileRemoteGateway现有suite，确保原47例的有效替代验收及新增竞态全部通过；再按真实变更判断是否需要已有Electron重连接线场景，存在交互变化时实际执行可用场景并记录环境限制，不冒称外部SSH已测。
- [ ] **Step 5: 静态/自审/提交。** 架构before/after、desktop owning context、格式/lint/diff，报告逐项原失败去向、source所有者、真实命令与统计；独立spec/quality审查，根门禁最终统一。

#### Task 12 Fix 1：释放重连期间尚未换代的 Renderer 关联

独立审查 I1 已用单项真实 manager 回归确认：A 已发布，重连 B 等 ACK 时，合法 `dispose(A)` 因 map 只剩 B 而静默失效，B scope/candidate 未回收。先在所属 spec 明确此关闭入口的映射及唯一所有者，再补正式确定性 RED，复用 route 现有最后已发布 Renderer 关联定位当前 route，并用当前 descriptor sessionId 释放 Host。不得新建无限别名表、第二套 owner 或 pending 队列。覆盖 ACK 前关闭 A、ACK 后通知前关闭 A、A→B→C 时关闭最后已发布关联、重复释放和迟到释放不误删后续独立 owner；旧 candidate 不得再提升或通知。保留所有已有 76 例和首次 Provisioning/手机边界，完整两 suite GREEN、定向静态与自审后提交，原实施者报告追加 Fix1；controller 按 `f28b8ac3` 到修复 HEAD 唯一 scoped 复审 I1 及增量破坏。真实 SSH 自动路径仍待最终统一验收。

### Task 13: 隐藏只有已结束智能体的空 mini 胶囊

**Files:**

- Modify: `packages/ui/src/v4/ConversationStatusPanel.tsx`
- Modify/Test: `packages/ui/test/v4ConversationStatusPanel.test.ts`
- Spec: `docs/desktop/multi-agent-display-spec.md`（已补mini与panel规则）
- Test/按需扩展: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-subagent-work-card.test.ts`

**Interfaces:** panel只派生现有运行/终态事实，不持久化新状态；正在查看的Side Pane由原owner保持，不受摘要退场影响。

- [ ] **Step 1: RED。** 复现现有 `does not keep a mini capsule alive for ended Agents alone` 失败，补mini/panel、只有ended Agent/有其他摘要/运行Agent/已结束workflow边界矩阵，按spec明确预期。
- [ ] **Step 2: 最小可见性修复。** ended Agent目录仅在panel时可独自保留shell；mini无内容时不因ended Agent存活。保留其他summary优先级、ended workflow和panel目录入口、运行Agent；修正过时中文注释并说明空胶囊根因。不得关闭详情、取消任务或把summary可见性当CLI事实。
- [ ] **Step 3: GREEN与交互。** 完整精确UI规格通过；运行现有subagent工作卡Electron场景，必要时增加结束后mini消失但已开详情保持的断言。只按目标包真实入口执行，遵循E2E case lifecycle/spec；不把静态HTML单测当交互E2E通过。原T08无需重新大范围审查。
- [ ] **Step 4: 静态/自审/提交。** DESIGN.md、架构before/after及UI相关context；定向格式/lint/diff，完整报告真实UT/E2E统计与环境边界，独立审查。

### Task 14: 设计可操作的本地资源锁恢复诊断出口

**Files:** Read-only `sourceServerReleaseResolver.ts` 与测试、shared source-server connectionErrors/connectionLog、Host sourceOperationLogs/连接失败出口、Main desktopRemoteSessions、实际Renderer连接错误与日志展示；对应standalone spec。

**Interfaces:** 只产出有证据的最小设计，不改正式source/test/spec/index/HEAD。原两条退出回收标记提示需要可操作的本地锁目录；公共错误/日志脱敏不能为过UT全局关闭。

- [ ] **Step 1: 核真实出口。** 从resolver异常一路跟踪到实际本地用户界面，列每处normalize/重建Error/消息schema/渲染的字段丢失与脱敏；不要把无人消费的metadata当作可操作UX。
- [ ] **Step 2: 提供最小方案。** 明确本地cache owner/可信lockDir来源、允许的结构化恢复数据/动作、普通日志与复制日志仍脱敏的边界；不能增加远端凭据/路径泄露旁路，不能仅把原路径断言改成redacted。若现有UI已有安全本地打开路径能力优先复用；若需要消息字段，列真实公开接口和迁移边界。给出最小改动文件与先spec后RED/GREEN的具体验收，不实施。
- [ ] **Step 3: 交付。** 产出task-14-report.md，区分已证实链路、方案权衡、必要的用户可操作步骤/实际组件以及未验证点；用图说明唯一owner与字段/动作流，不跑无关门禁。controller独立审查设计，再生成实施brief。

### Task 15: 实现可信且可精确定位的本机缓存锁恢复

**Spec:** `docs/desktop/standalone-coding-harness-spec.md` 的“中断回收的本机恢复出口”，先于实现生效。Task14 设计 Fix1 的逐层证据与文件定位保存在本计划 scratch 的 `task-14-report.md` F1—F8；其增量已由 `task-14-fix1-rereview.md` 独立审查通过。正文旧方案已被F1结论撤回，不再作为需求。

**Files（复用现有文件，不建通用metadata系统）:**

- shared: `source-server/release.ts`、`source-server/contracts.ts`、`source-server/errorCodes.ts`、`validation.ts`、`platform.ts`、`channels.ts` 及现有公开入口。
- client: `packages/client/src/globals.d.ts` 中既有 `window.zcode` 平台声明同步新增可选精确动作；不新增其他客户端能力。
- Host: `sourceServerReleaseResolver.ts`、`sourceServerConnectionManager.ts`、`sourceServerOperationLogs.ts`、`sourceServerManagementService.ts`、`host/index.ts`。
- Main/bridge: `desktopRemoteSessions.ts`、`desktopMainIpcRemote.ts`、`desktopMainIpcPlatform.ts`、`main/index.ts`、preload、desktopPlatform。
- UI: `root/useRemoteWorkspaceHistory.ts`、`remote-connection-flow/index.ts`、`app-shell/types.ts`、`requestRemoteProjectConnection.ts`、`project-sidebar/remote-project-connection.ts` 及必要的现有presentation类型；`remoteConnectionPresentationErrors.ts`、`RemoteConnectionConnectingStep.tsx`、`SourceServerManagementPanel.tsx`、中英文文案。
- Tests: 复用现有 resolver、shared contracts/log、remoteConnectionFailureContract、desktopRemoteSessions、Main平台、manager、management service、flow recovery、presentation、management panel 与 bridge/项目失败交接规格。实施报告必须列确切文件和命令，不用“相关测试”替代。

**Interfaces:** resolver 独占可信恢复事实，manager 只拥有当前失败状态，Main只拥有同配置本机目录动作，UI只保留当前错误的派生投影。严格 `cacheRecovery={kind:"source-server-cache-lock",version,target,sha256}`；可选动作名 `openSourceServerCacheRecoveryDirectory`。不改普通RPC协议、Agent协议或SSH Server接口。

- [ ] **Step 1: RED与精确范围。** 阅读DESIGN与架构context，按F3列逐层出口核当前字段。两原真实marker用例补严格locator、code/retryable、无绝对路径、fetch零次、owner/marker原字节和另SHA未变的回归，先失败；补秘密碰撞、伪造字段、真实RPC序列化、Main实际handler与UI三入口的关键失败证据。不要重做已通过的Task3句柄调查或Task14设计。
- [ ] **Step 2: 可信错误与明确出口。** 专用Error从已校验descriptor产生私有locator，固定安全正文；原normalize和secrets清洗保持。manager/Host失败reply/管理RPC data/Main/Renderer/flow/项目失败交接显式严格搬运同一字段，源服务器出口剔除非可信伪造保留名。新连接/更新、成功、断开、删除、reset/新epoch清除，不继承另一owner。不得将任意metadata展开到日志或公开响应。
- [ ] **Step 3: 本机精确动作与实际UI。** Main使用Host同配置root、当前version、native canonical/lstat检查和现有文件管理器helper，仅打开精确SHA父目录；严格拒绝额外/路径字段、版本漂移、junction/symlink越界、前缀碰撞、锁缺失/非普通目录，无root fallback、rm或下载。安全logger adapter处理原生失败，不返回路径。三个真实入口复用两现有组件，通过usePlatform显示定位、固定可复制离线步骤和原retry/update；可见性须code+严格locator+能力，失败/迟到结果不得污染新错误。
- [ ] **Step 4: 定向GREEN。** 原resolver整个文件（含Task3并发）全绿；shared严格/脱敏、真实RPC、Main IPC精确A/B SHA与覆盖root、伪造拒绝、桥接/失败交接/flow状态清理、UI三入口和按钮实际调用全通过。对主机配置的原参数、workspace identity、owner/lease/ACK不减覆盖。已有Task12改动按当前source复用，不重做其设计。
- [ ] **Step 5: 静态/报告/提交。** 定向lint/format/diff、架构before/after、相关context，逐字段列生产者/消费者及测试证据。报告task-15-report.md，独立spec/quality审查。根type/lint/完整gate整批controller执行。真实交互由Task16继续；Task15不能以UT宣称E2E或可发布。仅提交正式文件，scratch保留但不跟踪，不push/发布。

### Task 16: 验证缓存锁恢复的真实桌面交互与退出后重试

**Files:** 专门的测试lock fixture放在现有 `packages/desktop/test/e2e/helpers/`；候选场景 `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-source-server-cache-lock-recovery.test.ts`；当前case catalog/matrix与必要场景说明。遵守 `.agents/skills/e2e-case-lifecycle/SKILL.md`。不为测试创建新的产品恢复API。

**Interfaces:** 复用Task15真实Host resolver→Main→UI链和既有 `e2e-electron-reload.ts` 的完整旧进程树归零屏障；产品没有删除动作，只有fixture在无writer窗口清理自己的精确锁。

**已核实施边界：** 使用现有 `ZCODE_E2E_PACKAGED_APP_PATH`、隔离 `ZCODE_DESKTOP_DIST_DIR` 和 `ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY=1` 制作本次测试专用 win-unpacked，验证真实 release-versioned 缓存锁链；开发版 content-addressed 直接归档路径不算此验收。仅本次测试产物可用 Main 前置 wrapper 抑制 `app.setAsDefaultProtocolClient` 并记录调用，随后加载原 Main，避免写真实 HKCU 协议关联；不改生产源码或添加产品开关，不替换连接、错误或退出逻辑。正常产品菜单退出可在现有 reload 测试 helper 增加一个可选窄用途回调：完整旧进程树捕获后、deleteSession 前请求真实退出；默认行为和归零后回调/重启顺序不变，必须记录正常退出与 fallback 的区别。

- [ ] **Step 1: 准入与受控夹具。** 先catalog/matrix/spec，再fixture/场景。隔离HOME/USERPROFILE/userData/cache覆盖与descriptor/归档；探测真实目标，建立A/B两SHA和owner/.reaping原字节。两种marker都走实际连接/安装或更新，不Renderer注入Error。秘密碰撞保持为合成受控输入，禁止真实凭据。
- [ ] **Step 2: 构建与真实交互。** 按目标包当前脚本准备匹配Task15的新桌面产物，不和dist依赖测试并行。三入口均验证当前错误、精确按钮与retry/update；两种marker及秘密碰撞至少各触发一条真实链。记录Main原生打开的A目标一致性布尔证据，并至少一次系统层检查文件管理器实际打开A，不只spy/DOM断言。
- [ ] **Step 3: 退出后恢复。** 先复制安全固定步骤并保留文件管理器窗口，至少一次真实托盘/菜单正常退出并验证退出确认/Host清理；与helper强制fallback区分。精确A lock的夹具清理仅放 `afterElectronProcessExit`，旧进程树未归零不得删或建新session。保持同隔离profile/cache重启，通过原retry/update验证A恢复成功、B与归档未误改、成功后旧locator消失。禁止裸reload/rm、sleep或只等main PID。
- [ ] **Step 4: GREEN/报告与生命周期。** 按实际package命令运行精确候选spec，保存run/summary/脱敏证据与系统层结果；恢复环境，只清理本次fixture。使用最终新桌面产物补跑原T11 MODE02/03未包装的正式严格场景，Task17仅提供定位证据与命令，不替代此验收；不改原哨兵、timeout或终端产品。桌面e2e类型、定向lint/format/diff/架构通过；报告task-16-report.md并独立审查。若发现产品缺陷先报具体证据给controller，不通过削断言修绿。macOS/Linux未实机测则如实列出，根门禁继续由controller统一。

### Task 17: 只读补齐严格 PTY 输入异常的定位证据

**Files:** 只读原T11报告/诊断、现有终端输入组件/去重逻辑、TerminalService写入及MODE02/03实际E2E；证据与临时诊断仅存本计划scratch，不改正式代码/spec/index/HEAD。

**Interfaces:** 原T11-I3仍是独立验证事项，本任务不授权终端产品重设计或阈值变更。固定Node24.14.0与pnpm10.33.2，保持原严格完整哨兵和timeout；不将mock UT替代真实PTY。

- [ ] **Step 1: 复用已有证据。** 先读原T11-I3报告与带时间戳trace，仅列尚未回答的具体问题；不重跑已完成的缩放或Markdown修复，不重做全仓调查。
- [ ] **Step 2: 一次聚焦因果定位。** 以受控隔离fixture和实际E2E入口，在不改正式源码的前提下补齐 renderer键盘/composition/input/onData、平台write接纳、Service write及PTY回显的关联事件，分清重复UI输入、传输写入和仅显示异常。必要临时诊断用独立scratch配置/运行时观测，不能引入新测试门禁、宽松匹配或改产品路径。只为具体证据缺口运行，不高频重复碰运气。
- [ ] **Step 3: 交付与边界。** 报告task-17-report.md，记录真实命令、脱敏有序证据、确认根因/仍待证假设、最小后续建议和未覆盖条件。若严谨定位仍未完成如实报告，不改终端阈值/生产逻辑，不以推测宣布修复。禁止派子代理；不与dist构建并行，不碰用户正在使用的稳定版。

## 后续执行规则

Task 2 结果形成后，controller 在任何后续代码修改前把有证据支持的具体实施任务写入本文、检查共享文件/接口冲突并生成独立 brief。Task 1 与 Task 2 分别为已定位夹具修复和只读调查，可并行；同时最多一个源码实施者。所有修复完成后执行根 typecheck/lint、架构、29 规格定向检查与原始基线的完整 pre-push，再进行一次补充差异整体审查。旧 FR-I1 的关闭结果不重做。
