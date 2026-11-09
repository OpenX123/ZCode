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
