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

## 后续执行规则

Task 2 结果形成后，controller 在任何后续代码修改前把有证据支持的具体实施任务写入本文、检查共享文件/接口冲突并生成独立 brief。Task 1 与 Task 2 分别为已定位夹具修复和只读调查，可并行；同时最多一个源码实施者。所有修复完成后执行根 typecheck/lint、架构、29 规格定向检查与原始基线的完整 pre-push，再进行一次补充差异整体审查。旧 FR-I1 的关闭结果不重做。
