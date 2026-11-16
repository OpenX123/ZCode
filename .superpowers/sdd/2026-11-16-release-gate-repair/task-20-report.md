# Task20 实施报告

日期：2026-11-17。基线：`84d42371f6caabc353c2ffafcd598f1710e9e4e3`；开工 tracked clean。

## 范围与合同

- 先读取 `task-20-brief.md`，遵循根 AGENTS、architecture-governance 与 TDD 技能。只读取本任务要求及目标合同/源码/测试，未读取整个计划或 ledger。
- `docs/testing/1.4.1-gate-repair-spec.md` 的“桌面随包 Agent 的默认解析优先级”已包含完整合同，复用而不做无语义修改。实现前在 standalone spec 的“状态与接口”补入精确默认解析规则。
- 默认 Agent 仍由 Host 的同一个同步 resolver 解析；没有新增 runtime owner、异步解析框架或第二条命令构造路径。
- 顺序为：显式 command → Electron 精确 `process.resourcesPath/glm/zcode.cjs` → monorepo dist/src → Electron 历史/其他 JS fallback → 已部署 native。只有精确随包资源分支提升到 monorepo 前，历史目录链没有整体提前。

## 改动

1. `providerRuntimeResolver.ts` 新增精确随包 JS 查询，只接受当前 `process.resourcesPath` 下由既有 runtime 常量定义的固定入口；不查询用户历史或仓库候选。原 JS fallback 首项复用该查询，其余顺序不变；native 查询未改。
2. `zcodeAgentProcessManager.ts` 的既有 Electron 命令构造接受已解析入口，默认链先尝试精确随包资源，stdio 与 `storagePreparationEntry` 绑定同一 JS，保留 `supportsStorageStartup`、surface 与 workspace cwd 处理。中文注释写明启动 cwd 发现仓库 dist 的根因。
3. 两个现有 suite 中补入真实临时文件回归；显式隔离并恢复 HOME/USERPROFILE、cwd、resourcesPath/electron 描述符、显式 command/args/cwd、native 环境与开发字节码开关。没有依赖机器真实 bundle，也未修改 timeout/skip/schema。
4. 不修改 Main fork cwd、WDIO 环境清除、协议、Agent Runtime、Task19 UI 源码或测试。

## 环境与命令

全部 shell 命令均先执行以下 PATH 前置，再在仓库根目录执行所列命令：

```powershell
$env:PATH = 'C:/Users/21132/scoop/persist/nodejs-lts/cache/_npx/3e062c1ecdbab29f/node_modules/node/bin;' + $env:PATH
```

实际版本：Node `v24.14.0`、pnpm `10.33.2`；Vitest 输出 `v4.1.4`。pnpm 均有现有 package.json `pnpm` 字段弃用警告，未隐藏。

### 前置

- `node scripts/check-workspace-freshness.mjs`：exit 0。基线新鲜，relative `origin/main` ahead 71 / behind 0；当前分支没有远端跟踪，工具按既有合同跳过该项检查。
- `pnpm architecture:check --changed`：exit 0，`architecture: OK`，base `merge-base origin/main`，violations/baseline/new 均 0。
- `pnpm architecture:context services`：exit 0，现有 services fallback 为 `managed:false`，owner unassigned、无独立合同。此次只编辑该既有范围内文件，无新增 source 文件或跨模块接口。

### 精确 RED（实现前）

```powershell
pnpm exec vitest run packages/services/test/zcodeAgentProcessManager.test.ts packages/services/test/providerRuntimeResolver.test.ts -t 'Electron 精确随包资源优先于祖先仓库 dist|精确 resources bundle'
```

exit 1；2 files failed，3 tests failed / 63 因 `-t` 筛选未运行，共 66。没有新增或修改测试 skip。

- bytecode=false：期待 `resources/glm/zcode.cjs`，实际 stdio 与 storage 均指向真实临时祖先仓库 `apps/zcode-cli/packages/cli/dist/zcode.cjs`。
- bytecode=true：旧实现先进入仓库 dist 分支，抛“桌面 Agent 字节码入口缺失”；证明没有先选择已存在的随包 JS。
- 原 JS bundle resolver：期待临时 resources bundle，实际选择临时 HOME 下历史 bundle。模块加载时缓存 resourcesPath 的旧实现无法读取本测试明确设置的当前资源描述符；新精确查询按调用时资源位置读取。

### GREEN（两个完整既有 suite）

```powershell
pnpm exec vitest run packages/services/test/zcodeAgentProcessManager.test.ts packages/services/test/providerRuntimeResolver.test.ts
```

第一次完整运行 exit 0：2 files passed，66 tests passed（manager 55、resolver 11），总时长 58.79s。最终自审后再次完整运行同一命令：exit 0，2 files passed，66 tests passed，总时长 59.49s。

覆盖：精确随包与祖先 dist 共存（开发字节码关/开均使用随包 JS）、显式 command/args/cwd 原优先级、无精确资源时 dev dist 与 src 均先于历史 bundle、既有开发字节码/JS storage 与缺失错误合同、非 Electron 同时看到桌面/历史 JS 时仍走部署 native、精确查询缺失时不误返回历史 bundle 而原完整 fallback 仍可返回历史资源。

### 定向静态与差异

```powershell
pnpm exec oxlint packages/services/src/zcode-agent/zcodeAgentProcessManager.ts packages/services/src/runtime-tools/providerRuntimeResolver.ts packages/services/test/zcodeAgentProcessManager.test.ts packages/services/test/providerRuntimeResolver.test.ts
pnpm exec oxfmt --check docs/desktop/standalone-coding-harness-spec.md packages/services/src/zcode-agent/zcodeAgentProcessManager.ts packages/services/src/runtime-tools/providerRuntimeResolver.ts packages/services/test/zcodeAgentProcessManager.test.ts packages/services/test/providerRuntimeResolver.test.ts
git diff --check
pnpm architecture:check --changed
```

- 定向 lint：exit 0，4 files，0 warnings / 0 errors。
- 首次 format check：exit 1，3 个改动 TS 文件需格式化；仅对这 3 个目标执行 `pnpm exec oxfmt ...`，exit 0。最终上述 5 文件 format check：exit 0，全部匹配文件格式正确。
- `git diff --check`：exit 0；Git 提示工作区 LF 下次会按既有配置转换 CRLF，无 whitespace error。
- 修改后 `pnpm architecture:check --changed`：exit 0，`architecture: OK`，base `merge-base origin/main`，violations/baseline/new 均 0。没有运行 plain 全模块架构，也不宣称其无既有问题。

## 自审、concerns 与未执行项

- 自审确认：显式 override 在任何资源查询前返回；精确 helper 不包含 homedir/cwd 的 fallback；Electron gating 与命令构造复用原函数；monorepo 开发字节码分支和 SSH/native 代码不改。回归覆盖了错误提升整个历史链、漏掉 Electron gate、stdio/storage 分叉等主要变异。
- 测试是临时真实文件系统上的生产 resolver 回归，未把路径断言冒充实际 packaged Agent 运行。
- 按 controller 的执行分工，未执行根 `pnpm typecheck`、根 `pnpm lint`、完整 pre-push，交由 controller 在所有修复合并后统一运行；此次定向 lint 不等于根 lint。
- 未 build、emit dist、打包、运行 E2E、触碰资源服务或用户安装；未 push、未派子 agent/reviewer。
- 真实包准入仍由 Task16 对匹配新包同时核实 Main/Host 实际 spawn argv、原始协议生命周期及随包 hash 的一致性。Task16/12/13 保持 OPEN，本提交不关闭真实包门禁。
- 当前源码自审无新增 concern；独立 spec/quality 审查与上述统一验证仍待 controller 完成。

## 交接结论

最终两个完整 suite 为 66/66 GREEN，修改后 `--changed` 架构与定向 lint/format/diff 通过。本报告与实现、测试及 standalone spec 同一正式提交；准确 SHA 由交接回复给出。源码 writer 在该提交完成后释放，等待独立审查，不自行继续打包或扩大修改。
