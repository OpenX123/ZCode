# 引擎输入区精简、无感切换与 Subagent 可视化：验证记录

> 对应方案：`docs/plans/2026-11-09-engine-composer-subagent-polish.md`。各工作项按小节追加，只记录实际执行的命令与真实结果。

## W4 基线

### 数据来源与过滤

- 只读聚合本机真实日志，未复制任何正文、路径以外的用户内容或凭据。聚合脚本放在系统临时目录，不入库。
- 安装版（YCode 1.2.0，CLI 0.17.0）：`~/.zcode/cli/log/zcode-2026-11-04..10.jsonl`（UTC）。剔除测试数据：`bootstrap.app.startup.*` 的 `workingDirectory` 位于 `%TEMP%\ycode-external-app-*` 的 58 个测试进程，按其 sessionId 及首尾时间窗（前 2s、后 5s）排除，共剔除 104 条外部引擎事件，保留 121 条（2026-11-07 至 11-09）。
- 安装版不含窗口备用许可（许可在 `1f7e7266` 引入，安装版日志中没有 `external_engine.spare.reserved` 事件）。带许可的构建只在 dev 预览隔离目录运行过：`~/ycode-preview-home/.zcode/cli/log/zcode-2026-11-08..09.jsonl`（86 条，无测试进程），其中 2026-11-09 18:00Z 之后的 59 条来自带许可的构建（出现 `spare.reserved`）。
- Host 日志 `~/ycode-preview-home/.zcode/v2/logs/2026-11-09.log`（机器时钟 EST，renderer 与 Host 在 `[pid:46472]`/`[pid:51052]`），用 `settingService` 写入 `defaultSessionEngine` 的时间近似点击切换时刻，与 CLI UTC 的 `handshake.completed` 对齐。

### 带窗口单许可的构建（dev 预览，2026-11-09 18:00Z 起）

默认引擎为 Codex，用户在草稿里反复切换 Codex ↔ Claude Code。

| 分组                            | n   | launchMs p50/p90/max | initializeMs p50/p90/max | sessionMs p50/p90/max | configRestoreMs p50/p90/max | totalMs p50/p90/max |
| ------------------------------- | --- | -------------------- | ------------------------ | --------------------- | --------------------------- | ------------------- |
| Claude `session/new` spare=miss | 11  | 116 / 195 / 303      | 814 / 4206 / 5028        | 834 / 1445 / 1547     | 22 / 25 / 37                | 1741 / 5097 / 6488  |
| Codex `session/new` spare=hit   | 7   | 5 / 914 / 914        | 0 / 0 / 0                | 0 / 0 / 0             | 2 / 3 / 3                   | 8 / 916 / 916       |
| Codex `session/new` spare=miss  | 1   | 132                  | 1017                     | 1574                  | 1                           | 2724                |

备用事件：Claude `spare.miss reason=none` 11 次、Claude `spare.ready` **0 次**；Codex `spare.reserved/claimed` 7 次、`spare.ready` 9 次（durationMs p50 1217）、`spare.miss reason=none` 1 次（窗口首个草稿）。

点击切换（Host 写 `defaultSessionEngine`）→ CLI `handshake.completed`：

- Claude：5425ms（首次，initialize 4.2s 冷启）、1847、2001、1784、3476、3324ms；去掉首次 p50 约 2.0s，与用户反馈“约 2s”一致。
- Codex：247、275、442、234ms（全部命中备用）。

### 安装版（无许可，2026-11-07 至 11-09）

| 分组                            | n   | totalMs p50/p90/max   | 备注                                            |
| ------------------------------- | --- | --------------------- | ----------------------------------------------- |
| Claude `session/new` spare=hit  | 5   | 137 / 1759 / 1759     | 1759 为旧版只省 spawn/initialize 的备用         |
| Claude `session/new` spare=miss | 19  | 12106 / 33881 / 48653 | 含 11-07 窗口重载 6 工作区并发握手的 5–48s 样本 |
| Claude `session/resume`         | 4   | 7915 / 14166 / 14166  |                                                 |
| Codex `session/new` spare=hit   | 2   | 113 / 148 / 148       |                                                 |
| Codex `session/new` spare=miss  | 4   | 4073 / 48003 / 48003  |                                                 |
| Codex `session/resume`          | 1   | 2530                  |                                                 |

miss 原因：Claude `none` 18 次、`warming` 1 次；Codex `none` 5 次；`cwd` / `generation` / `unhealthy` / `budget` 均为 0。备用 `spare.ready` durationMs：Claude p50 2320 / p90 3705 / max 4341（n=20），Codex p50 1326 / max 2873（n=6）。`spare.claimed` 只有 8 次，`spare.expired` 16 次：没有按引擎预热时，备用大多在 10 分钟内无人领用。

### 结论

- **“单许可挤占”假设成立**：带许可的构建中，Codex 备用每次被领用后立即补位并重新占住窗口唯一许可；Claude 每次新草稿都 `miss reason=none`，其补位申请被 Host 拒绝且没有任何日志（`process-pool.ts` 拒绝分支静默 `discardSpare`），所以 11 次切换中 Claude 一次 `spare.ready` 也没有。对照安装版（无许可）每次 Claude miss 之后都有 `spare.ready`。
- **“cwd/generation 不匹配”假设不成立**：两套日志中 `reason=cwd|generation` 均为 0 次（pool 先判 none 再判 cwd/generation，若存在会单独记录）。W4 第 3 步（改 Host 备用 cwd）不实施。
- 次要原因：Host 只在取得 CLI 时为默认引擎调度一次（`scheduleSpare` 每 client 一次），非默认引擎只能靠“先冷启一次再补位”获得备用；即使不受许可限制，Claude 第一次切换也必然冷启。
- 备用命中后的就绪耗时：Claude 预建会话 hit totalMs 104–207ms（安装版 11-08/11-09 四次，另一次 1759ms 为旧版只省 spawn/initialize 的备用）、Codex hit 6–17ms（dev 预览），满足 ≤1s；选项清单要等握手结束才到达，命中前控件不显示，需要缓存清单覆盖 ≤100ms 目标。

### 空闲进程内存

本 lane 未启动应用，也未自行启动真实 adapter（会使用真实 `~/.claude` 配置），**未重新测量**空闲 Claude 预建会话内存。沿用 spec 中 2026-11-08 本机实测：adapter 约 80MB + claude.exe 约 400MB 私有提交（工作集 80–135MB）。需在桌面人工验收时用任务管理器或 `Get-Process` 复测。

## W4 实现验证

环境：Windows 11，系统 Node 24.18（`mise.toml` 要求 24.14，未切换），worktree 分支基于 `1f7e7266`。CLI 包测试前先 `pnpm --filter "@zcode/bootstrap^..." build`，改动后重建 `@zcode/contracts`、`@zcode/adapters`、`@zcode/core`、`@zcode/bootstrap`（bootstrap 测试解析 adapters 的 dist）。

先写失败测试再实现，红灯确认：

- adapters `tests/external-engine-process-pool.test.ts -t W4`：4 failed（Claude 补位因无 engine 被 legacy 单许可挡住超时；无 `refill_denied`；`createExternalEngineConfigCatalog` 不存在）。
- core `tests/external-engine-config-catalog.test.ts`：1 failed（会话输入无 `workspaceKey`/缓存发布）。
- bootstrap `tests/external-engine-v4.test.ts -t 缓存选项`：临时还原 projection 实现后 1 failed（`engineConfigOptionsSource` 为 undefined）。
- services `zcodeAgentConversationVisibility.test.ts`：重命名 selector 后 5 failed；`externalEngineSpareSelection.test.ts` 模块不存在。
- UI `engineSwitchReadyMarker.test.ts`：2 failed（函数不存在）。
- UI `v4SessionPaneExternalEngineDraft.test.ts` 的 W4 用例只验证既有渲染路径（connecting 时已透传快照清单并禁用），无需改 UI 组件，首次即通过；shared schema 用例在实现后补写。

绿灯（定向文件，非全量）：

| 命令                                                                                                                                                                                                                                                         | 结果                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adapters：`npx vitest run tests/external-engine-process-pool.test.ts tests/external-engine.test.ts tests/external-engine-connection.test.ts tests/external-engine-recovery.test.ts tests/external-engine-fork.test.ts tests/session-external-engine.test.ts` | 6 files，86 passed / 1 skipped                                                                                                                                                                             |
| core：`npx vitest run tests/external-engine-config-catalog.test.ts tests/external-engine-plan-errors.test.ts tests/session-fork.test.ts`                                                                                                                     | 3 files，41 passed                                                                                                                                                                                         |
| bootstrap：`npx vitest run tests/external-engine-v4.test.ts tests/external-engine-session-visibility.test.ts tests/external-engine-app-integration.test.ts tests/external-engine-connection-binding.test.ts`                                                 | 4 files，24 passed                                                                                                                                                                                         |
| services：`npx vitest run packages/services/test/zcodeAgentConversationVisibility.test.ts packages/services/test/externalEngineSpareSelection.test.ts packages/services/test/externalEngineService.test.ts`                                                  | 3 files，43 passed / 1 skipped                                                                                                                                                                             |
| shared：`npx vitest run packages/shared/test/zcodeProtocolV4SessionEngine.test.ts packages/shared/test/zcodeProtocolV4SessionVisibility.test.ts`                                                                                                             | 13 passed                                                                                                                                                                                                  |
| UI：`npx vitest run packages/ui/test/engineSwitchReadyMarker.test.ts packages/ui/test/v4SessionPaneExternalEngineDraft.test.ts`                                                                                                                              | W4 与埋点用例通过；P08「creating/connecting 可发送…」1 failed，为基线既有失败（还原本 lane 改动后在 `1f7e7266` 上同样失败：测试读取 `engineControls.props.loading`，而该 prop 已是 `leadingActions` 元素） |

全局：`pnpm typecheck` 通过；CLI 包 `pnpm --filter @zcode/contracts --filter @zcode/adapters --filter @zcode/core --filter @zcode/bootstrap typecheck` 通过；`pnpm lint` 0 errors（91 warnings，均不在本 lane 文件）；`pnpm architecture:check --changed` OK（0 violations）。桌面 E2E 候选 `conversation-session-external-engine-prewarm.test.ts` 新增「W4 Codex → Claude → Codex 热切换」，只做了 `tsc -p packages/desktop/tsconfig.e2e.json --noEmit`，**未运行**。

未验证（需要桌面人工）：真实 Windows 上切换后 `[engine-switch] controls ready` 的 cached ≤100ms / live ≤1s P95；第二个空闲预建进程的实际内存；Host 在 `defaultSessionEngine` 写入后的重调度在真实窗口中的时序（集合扩大与 createSession 并发时，首次切换到新引擎仍可能冷启或领用 warming 备用）。

## 桌面 E2E

日期 2026-11-09（UTC 21:50–23:16），主检出 `codex/acp-connection-experience`（HEAD `1e70dd92` 起），真实 Electron 41 / Host / CLI / stdio，Windows 11。

### 运行方式

从仓库根执行 `.scratch/engine-e2e/run.cjs`（本地 runner，复用 `.scratch/acp-runtime/final-fix-run.cjs` 的隔离配方，不入库）：固定 Node `.scratch/acp-runtime/node-v24.14.0-win-x64/node.exe scripts/mise-run.mjs pnpm --filter @zcode/desktop test:e2e -- --spec <file>`。runner 子进程环境：

- 删除 `ELECTRON_RUN_AS_NODE` 与所有 `ANTHROPIC_` / `OPENAI_` / `CODEX_` / `CLAUDE_` / `AZURE_OPENAI_` 前缀变量，再只设 `ANTHROPIC_BASE_URL=https://claude-inherit.example`、`OPENAI_BASE_URL=https://codex-inherit.example`；
- `ZCODE_E2E_MANUAL_REVIEW=1`、`E2E_PROVIDER_HTTP_MODE=replay`、`ZCODE_DESKTOP_AGENT_BUILD_MODE=pnpm`；
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=<repo>/packages/desktop/test/e2e/fixtures/upstream/common.json`；工作卡用例追加 `,<repo>/packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-work-card.json`；
- `ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN=<repo>/.scratch/acp-runtime/task4-fixture-bin` 并置于 PATH 首位（`claude` / `codex` 状态桩，只回 `--version` 与已登录状态）。HOME / USERPROFILE / 数据目录由 E2E runner 隔离为 `packages/desktop/.e2e-home-<runId>`，未触碰真实 `~/.zcode`、`~/.claude`、`~/.codex`。每轮重建 desktop/CLI；无凭据、无真实供应商请求。

### 结果

| 轮次  | 用例      | 结果                     | 产物目录（`C:/github/ZCode/packages/desktop/.e2e-artifacts/`） | 说明                                                                                               |
| ----- | --------- | ------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| run1  | prewarm   | 4 passed / 7 failed      | `desktop-e2e-20261109215206033-p49496-b81b8ae3ffcbd185`        | 夹具配方生效（不再报缺 PATH）；失败为 W2/W3/D2 旧期望与 W4 引擎胶囊 test id                        |
| run2  | prewarm   | 4 / 7                    | `desktop-e2e-20261109215954588-p50756-487c129c06638155`        | 同 run1（诊断改动因 CRLF 未落盘）                                                                  |
| run3  | prewarm   | 6 / 5                    | `desktop-e2e-20261109220651496-p53944-dfd4bce63b7939c6`        | 修就绪判据、档位本地化、W4 经弹层切换后；暴露 W3 默认 high、P11b 不回填、W4 Codex 5.5s             |
| run4  | prewarm   | 未执行（构建失败）       | `desktop-e2e-20261109222101934-p30652-776a89c497070070`        | 本人新增日志代码丢失类型收窄，adapters tsc 失败，已修                                              |
| run5  | prewarm   | 8 / 3                    | `desktop-e2e-20261109222723811-p44012-1f77d747f9f41931`        | P11b 通过（Composer 修复）；新日志确认 W4 失败为 `spare.rejected reason=identity` + 约 5s 同步收口 |
| run6  | prewarm   | 8 / 3                    | `desktop-e2e-20261109224217619-p52476-51bd56da31db6372`        | W4 通过（warm codex 299ms / claude 303ms）；AX03 偶发收起“更多选项”、滑杆用例入口元素重排          |
| run7  | prewarm   | **10 passed / 1 failed** | `desktop-e2e-20261109225246590-p12408-f320ea0969ceef89`        | 最终；剩 P11（见下）                                                                               |
| run8  | work card | 0 / 1                    | `desktop-e2e-20261109230028935-p55312-20ddff99c1449c5f`        | before 钩子通过、父轮回放通过；子会话第 3 步缺 fixture                                             |
| run9  | work card | 0 / 1                    | `desktop-e2e-20261109230558648-p40260-cc43ca70d27629e2`        | 子会话 mid-turn compact（E2E 模型 contextWindow=240）                                              |
| run10 | work card | **0 / 1**                | `desktop-e2e-20261109231157596-p53300-11714f8f208f5f2e`        | 最终；工作卡在已完成父轮的折叠历史里，见下                                                         |

run7 W4 计时（`external-engine-w4-switch-timing.json`）：warm Codex visible/enabled 302.7ms，Claude 355.9ms；日志无 `spare.rejected reason=identity`。

### 修复

测试夹具（harness）：

- prewarm：W2 起草稿入口挂着引擎切换行而恒可点，入口 enabled 不再代表原生配置就绪；新增 `waitForEngineConfigReady`，以同一 `configDisabled` 驱动的权限芯片 `engine-config-mode` enabled 为判据（AX03、P11、停止、滑杆、冷恢复与 P11 连接中发送断言）。
- prewarm：W4 用例改为经模型弹层 `engine-switch-option-<engine>` 切换（旧 `session-engine-option-*` 已随 W2 删除），可操作计时同样看权限芯片。
- prewarm：D2 档位本地化（zh-CN 低/中/高）替换 "High/Medium/Low" 旧期望；W3 首次默认 high 替换 AX03 的 `_low_1` 回复期望。
- prewarm：夹具入口内容未变时不重写（每个用例重写会改 mtime，使前一用例补位的备用被身份校验作废）；“更多选项”只在未展开时点击；滑杆用例窄窗重排后重新取入口并确认弹层出现；失败诊断按用例序号分文件并附截图。
- work card：改用按焦点 pane 解析的 `prepareV4ConversationE2E` / `sendV4Prompt` 等 v4 helper。根因：`helpers/conversation-session.ts` 的 `inspectConversationComposer` 写死 `v4-session-pane-workspace-main` 并取第一个 `v4-composer-input`；双栏工作台（`e7adc8ca`，main 上已存在）后每个 Tab 的 pane id 都是 UUID、非活动 Tab 保持挂载隐藏，草稿就绪判断恒为 false。这是共享 helper 的既有缺陷，不是 W2/W5 回归；本轮未改共享 helper（约 104 个 spec 引用，需单独验证）。
- work card：新增 case-local replay fixture；marker 改为固定值（回放无法回显随机 runId）；SAT31 超时报告最新状态（原 `timeoutMsg` 在调用时求值恒为 null）。

产品修复：

- Composer 草稿首发失败不回填（W5 合同违背，P11b 复现）：乐观清空调用的 Lexical `clear()` 经 `editor.update` 在微任务里回传 `onChange("")`，晚于提交时记录的 `cleanupRevision`，失败时被误判为用户已编辑而跳过回填。修复为乐观清空后编辑器仍为空时照常回填；有新输入时不覆盖。UT：`packages/ui/test/v4ConversationComposerPromptHistory.test.ts` 新增 2 例（先红后绿），全文件 25 passed。
- W4 预留后失效的备用阻塞前台约 5s：日志补 `external_engine.spare.rejected`（reason），identity / unhealthy 改为后台 retire（许可与 owned 仍在确认退出后释放），关闭/取消/已丢弃保持同步。spec `external-agent-engines-spec.md` 规则 5a；UT `external-engine-process-pool.test.ts` 新增 1 例（先红后绿），“安装入口替换”用例改为最终确认退出，全文件 37 passed。

### 剩余失败

- prewarm P11（连接中立即发送）：重启后首发使用记忆的模型 `fixture-3` 但深度为 low，期望 high。根因（代码证据 `useEngineConfigMemory.ts` 352–360 行、`EngineConfigPicker.tsx` commit 早退）：W3 首次默认 high 只在“该引擎 + 连接没有任何记忆”时下发且不写记忆；用户在显示“高”的滑杆上按 End 是无变化提交，不写记忆；随后选模型产生了记忆 {model}，重启后不再套首次默认，深度回到原生 low。是否应按配置项分别套首次默认（`{...firstUseDefaults, ...remembered}`）属于 W3 语义选择，待用户确认，未改代码。
- work card SAT31：父轮按指令派发后台 Explore 后立即回复并结束，工作卡位于父轮“已工作 2 秒”折叠历史内，子智能体运行中（胶囊“1 个运行中”）时间线不可见（截图 `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109231157596-p53300-11714f8f208f5f2e/subagent-work-card-failure.png`）。与 spec“运行中不可折叠”的意图冲突，需确认“轮次折叠是否豁免运行中的工作卡”，未改代码；SAT32/SAT33 因此未执行到。

### 截图（run7，人工 review）

- 输入区与弹层：`C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109225246590-p12408-f320ea0969ceef89/task5-composer-1280-light.png`、`task5-composer-1280-dark.png`、`task5-composer-640-light.png`、`task5-composer-640-dark.png`、`task5-model-effort-fast-popover.png`、`task5-fixed-engine.png`、`codex-keyup-slider.png`。
- 首发即时布局 / 失败回填：本轮用例只做 DOM 断言，未产出截图（P11b 通过）；run3 修复前的不回填截图 `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109220651496-p53944-dfd4bce63b7939c6/external-engine-case-07-failure.png`。
- 工作卡与右侧详情：未产出（SAT31 失败），仅上方失败截图。

### 静态检查

`pnpm typecheck` exit 0；`pnpm lint` exit 0（92 warnings / 0 errors，本轮文件无新增告警）；`pnpm architecture:check --changed` OK（violations/baseline/new 均 0）；`tsc -p packages/desktop/tsconfig.e2e.json --noEmit` exit 0；adapters `tsc --noEmit` exit 0。
