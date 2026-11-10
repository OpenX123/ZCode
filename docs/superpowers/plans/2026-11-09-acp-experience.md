# ACP 体验实现计划

> **For agentic workers:** 使用 subagent-driven-development 逐项执行与审查。本次用户已授权连续实施，不再询问执行方式。

**Goal:** 落地已接受的 ACP 连接、配置与参考图 UI。
**Architecture:** Host 配置/诊断，Runtime 绑定/确认，Port/Pool 连接；UI 通过既有 hooks，单一写入链。现有未提交改动保留，基线 `4f367fabeac7ca0dabf7eb93d8397d8e49f3ac4d`。
**Tech Stack:** React/TypeScript、Radix、Vitest、CLI stdio、Electron WDIO。
**Spec:** `docs/desktop/external-agent-engines-spec.md` 顶部“ACP 体验改造”；设计证据 `docs/design/2026-11-09-acp-optimization-proposal.md`。

## Global Constraints

- 所有 UI 文案国际化；遵守 DESIGN，语义 token、text-ui-\*，无额外依赖。
- 每个任务先写行为测试并运行失败，再实现再运行。禁止全量单测。
- 不提交、推送或更改生产数据；当前分支 codex/acp-connection-experience，保持原有修改。
- 跨模块用公开入口；代码 bugfix 添加中文原因注释；先读 architecture context。
- 任务间接口必须说明；未完成项不可伪称完成。

### Task 1: 引擎管理与诊断

**Files:** `packages/ui/src/external-engine/EngineSettings.tsx`、`EngineConnectionProfiles.tsx`、同目录新增聚焦组件；`packages/services/src/external-engine/`、`packages/shared/src/external-engine/` 的现有合同；两种语言 messages；`packages/ui/test/externalEngineSettings.test.ts`、`packages/services/test/externalEngineService.test.ts`。
**Interfaces:** 沿用 `IExternalEngineService.getStatus/refreshStatus/updateConnectionProfiles/testConnection`；新增检查结果为可选字段，不能增加健康发送门禁；每份认证结果必须带对应 profileId。UI 所选引擎/配置只属于查看草稿，不写 lastUsed，点击选择操作才写。

- [x] 写并执行失败测试：左侧两引擎选择仅显示对应详情；预读配置不等待所有诊断；非诊断配置不得显示默认身份认证；编辑后旧绑定不改。
- [x] 实现图2的紧凑主从页面、分项 checks 与适用修复动作，成功项可折叠，失败项展开；复用安全配置与凭据规则。
- [x] 保留检测/登录/安装/测试取消，配置编辑 Dialog，信息来源说明与保存生效提示。
- [x] 定向 UT、格式、对照 spec 自查；写任务报告。

### Task 2: Composer 与按连接记忆

**Files:** `EngineControls.tsx`、`EngineConfigPicker.tsx`、`contract.ts`、`ConversationComposer.tsx`、`SessionPane.tsx`、`useEngineConfigMemory.ts`、共享 AppSettings schema/merge、相关 UI 单测、messages。
**Interfaces:** 复用 `engineControls` 与现有配置回调，不更改 Runtime 确认链；必要新增可选 `placement` 等展示属性，向根代理报告。偏好保留 legacy field，新增按 profile 读取/增量写入字段，缺省 ID 用既有 identity resolver。

- [x] 写并运行失败测试：草稿分段 selector 位于输入区上方；常驻权限/连接/模型/effort 不含 Fast，更多内仍可显式配置；已有会话只读引擎。
- [x] 写 hook 失败测试：两 profile 不串 model/effort，旧值可初始化，无连接记录不覆盖他方。
- [x] 实现图1紧凑布局与连接详情/诊断浮层，保留输入/草稿/连接时发送语义；Fast 仅移位置不改值。
- [x] 实现偏好与相关中英文文案、模块合同；定向测试与报告。

### Task 3: 准备与备用资源

**Files:** `apps/zcode-cli/packages/adapters/src/external-engine/{index,process-pool,connection}.ts` 及测试；必要 CLI contracts/bootstrap；`packages/services/src/zcode-agent`、Host/共享协议中现有外部引擎接线；相关合同/测试。
**Interfaces:** 同会话 prepare single-flight 保持；warming 预留只归一个新会话，按 cwd/engine/profile/环境代次隔离。窗口预算仅拥有未绑定备用许可，不持有会话；跨进程通过现有协议注入授权，生命周期关闭收口。先用架构上下文确认接入位置，不引入独立全局进程池。

- [x] 写并执行失败测试：warming 时不重复 spawn；两个新会话不同原生 ID；取消/失败/关闭无遗留。
- [x] 实现原子预留、有效性检查；测命中路径，避免完整无变化 launch 解析且不绕过身份检查。
- [x] 写并执行窗口预算/提前准备测试；只对已有活动 workspace CLI 低优先准备；拒绝预算不阻塞前台。
- [x] 实现受控准备/许可回收，保留 idle 和恢复合同；定向 CLI/Host 测试与性能证据报告。

### Task 4: 交互回归与最终集成

**Files:** 扩展 `conversation-session/manual-review/pending/conversation-session-external-engine-connections.test.ts` 及 `external-engine-prewarm.test.ts`；case catalog/coverage matrix/验证记录。
**Interfaces:** 复用现有隔离 ACP fixture，不用真实凭据；对应 AX01–07，不自动转正。

- [x] 更新并执行桌面候选，检查设置 master/detail、Fast 更多、固定绑定、切换和主题布局。
- [x] 执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响根 UT 与目标 CLI 测试；格式检查只针对改动。
- [x] 审查全部 diff、修复真实问题、记录验证边界与未达性能目标；保留可评审改动。

### Task 5: 按最新 Codex 参考图精简输入区

> **已被取代（2026-11-09）：** 本任务的输入区精简由 `docs/plans/2026-11-09-engine-composer-subagent-polish.md` 的 W1（外部引擎输入区精简、Fast 闪电开关 R2-1）与 W2（引擎切换并入模型入口、移除输入框上方胶囊）取代，不再单独实现；以下勾选项保留为历史记录，验收以 `docs/desktop/external-agent-engines-spec.md`「Composer 引擎切换与外部引擎输入区（W1/W2/R2-1）」为准。

**来源：** 用户在桌面截图验收后追加“沿用 CLI 配置不要在输入框显示”“分支要在上面，参考 Codex，就只要这些”。最新 spec 的 Composer 三条规则取代 Task2/4 中旧连接入口与独立更多按钮的展示要求；配置、绑定与发送语义保持。

**Files:** 外部引擎 Controls/Picker 与合同；ConversationComposer/SessionPane 的展示接线；项目头部必要的既有 ProjectComposerMenu/WorkspaceShellLayout 展示；聚焦 UI 单测、一个桌面候选、验证文档。只改展示与测试，不扩展 backend，不恢复已移除的 CUA/后台入口。

- [x] 先写并运行失败断言：所有连接标签/选择器不在输入区；左附件/权限、右单个模型深度入口；Fast 只在弹层内；项目/运行位置/真实 Git 分支均在编辑器上方同一行。
- [x] 实现新布局，复用原生目录、确认回调与现有 Git/项目事实；不重复 picker 状态，不改变绑定或首发屏障；更新旧合同中的冲突展示说明。
- [x] 定向 UI UT、真实 Electron 聚焦布局/键盘/模型深度/Fast/首发回归；隔离环境重拍宽窄深浅截图，使用真实 Git 夹具验证头部。
- [x] 根 typecheck/lint、定向 e2e 类型/格式/架构与任务独立审查，再做全部改动最终审查。保留历史通过记录，区分被本次替换的展示合同。
