# 轮次无响应提示（1.5.0）

## 背景

外部引擎（Claude Code / Codex ACP）轮次没有 idle 检测，`session/prompt` 也没有超时；对话区的“工作中 X 分 Y 秒”只是墙钟，用户无法区分“模型在长时间思考 / 工具在跑”和“连接已卡死”。本规范新增由 runtime 统一记录的轮次活动事实，并据此在 UI 上派生无响应提示。

## 产品规则

- 无输出时间 = `now - turnActivity.lastActivityAt`。
- 阶段 `waiting_model`：
  - 无输出 `< 60s`：不显示。
  - `≥ 60s`：提示行“{engine} 已 N 分钟无输出 · 等待模型响应”（次要文字色）。
  - `≥ 5min`：升级为警告样式（`warning-surface`），主按钮“中断并重试”，次按钮“中断”“查看日志”。
- 阶段 `running_tool`：不视为无响应，**不显示独立提示条**（1.5.1）。工具执行 `≥ 60s` 时，在 `turnActivity.activityPhase.toolCallId` 对应的那一行工具行尾追加耗时（如“正在执行 curl … · 1 分钟”），不升级为警告，不显示按钮。工具名沿用工具行自身的显示名（“终端”“正在执行”等），不再出现原始工具名（如 `Bash`）。
  - 1.5.1 修正原因：1.5.0 的独立提示条“正在执行 Bash，已 1 分钟”与正上方的运行中工具行“正在执行 curl …”重复，且使用原始工具名，见下文“1.5.1 回归”。
- 存在待处理交互（审批 / 提问，`pendingInteractions` 非空）或轮次不在 `running`：不显示。
- 不自动重试、不自动中断。
- 原生引擎与外部引擎同样适用：任何引擎事件都会刷新 `lastActivityAt`。
- 旧 runtime 不下发 `turnActivity` 时不显示提示（不做 UI 端推测）。

N 为向下取整的分钟数（至少 1）；工具行耗时同样 `≥ 60s` 才显示。`{engine}` 取 `ENGINE_LABELS`（YCode / Claude Code / Codex）。

## 状态所有者与协议

唯一所有者：CLI `ProductProjection`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`）。UI 只读取并派生展示，不维护第二份活动时间。

协议：`ConversationSnapshot.turnActivity`（`packages/shared/src/zcode-protocol-v4/snapshot.ts`），`StatePatch.turnActivity` 键级整体替换。

```ts
turnActivity: {
  turnId: string;            // 当前 runtime 轮次
  lastActivityAt: number;    // 最近一次引擎事件时间（epoch ms，取事件 timestamp）
  phaseStartedAt: number;    // 进入当前阶段的时间
  activityPhase:
    | { kind: "waiting_model" }
    | { kind: "running_tool"; toolName: string; toolCallId?: string };
} | null
```

- 运行时校验：zod strict 对象；snapshot / patch 中该键对未知形状降级为 `null`（`.catch(null)`），避免未来新增阶段使旧客户端整份快照解析失败。`packages/shared/src/zcode-protocol/index.ts` 同步 re-export。
- `turnActivity` 不在 `REVISION_BEARING_PATCH_KEYS` 中：它是高频派生事实，没有命令以它做 CAS，计入 revision 会让运行中的 retry/edit/queue 等 CAS 命令假失败（与 `workflowRuns` 同类豁免）。

### 事件顺序

```text
TurnStarted(agent)          → turnActivity = {turnId, lastActivityAt=t, phase=waiting_model}
ModelStreaming / ModelComplete / StreamingToolLedgerUpdated
ToolCallScheduled / Started / Progress / Result / Error
PermissionRequested / PermissionResolved
                            → lastActivityAt = max(prev, t)；phase 按当前 open foreground tool 重算
TurnComplete / TurnError / 中断（phase 离开 running）
                            → turnActivity = null
```

- 阶段判定：reducer 更新完 tool 索引后，若存在 `status=running` 的前台 tool row，取 rowId 最大者为 `running_tool`；否则 `waiting_model`（`inputStreaming` 表示模型仍在输出工具参数，归入 `waiting_model`）。
- 只接受当前轮次的事件（`acceptsActiveModelEvent`：running 且 turnId 匹配），迟到事件不刷新。
- 节流：阶段 / 轮次 / 工具不变且距上次发布 `< 5s` 时不发布新的 patch，避免逐 token 产生 `state.updated`。因此 UI 读到的 `lastActivityAt` 最多滞后真实活动 5s，相对 60s / 5min 阈值可忽略。
- 时间全部来自事件 `timestamp`，cold hydration（`transcript-hydration` 合成事件）与 resume replay 会得到相同结果；snapshot / 重连后由快照直接携带。

### 交付

```text
desktop: continuous ── live state.updated(turnActivity) ──┐
                                                         ├─ 同一 ProductProjection 与 seq
mobile: replayable ── snapshot.turnActivity + gap repair ─┘
```

## UI

- 模块：managed UI 模块 `turn-stall`（`packages/ui/src/turn-stall/`）。派生函数 `resolveConversationStallState`（纯函数，可单测）。
- 组件：`ConversationStallNotice`，由 `SessionPane` 通过 `ConversationTimeline` 的 `liveTailFooter` 渲染在运行中轮次（live tail）末尾；组件只在 `turnActivity` 非空且运行时每 5s 自行 tick。只读会话（`readOnly`）不显示。
- 对齐：`liveTailFooter` 容器与轮内容共用同一水平内边距（`ConversationTurnGroup` 导出的 `TURN_CONTENT_INLINE_PADDING_CLASS`，`px-4 @md/conversation:px-6`），提示条与轮内工具行同一左边线。1.5.0 容器只有 `pb-2`，提示条贴在内容列最左侧（比轮内容左移 16/24px）。
- 工具行耗时：`SessionPane` 用 `RunningToolActivityProvider`（turn-stall 模块）包住时间线，provider 只把 `turnActivity`（及 running / 待处理交互 / 只读）派生成「当前运行工具 `{toolCallId, phaseStartedAt}`」写入一个外部 store；`ToolLayout` 在 `isRunning` 时经 `useRunningToolElapsedLabel(ids)` 订阅，只有 id 命中的那一行每 5s tick 并显示耗时。单工具行的 id 为自身 `toolId`；分组行（Execute / Explore / Changes / MCP / CUA 组）传入子工具 id，组展开后由子行显示，组头不重复。provider 缺省（嵌套渲染、历史回放）时不显示。
  - 状态所有者不变：耗时只从 `turnActivity.phaseStartedAt` 派生，UI 不保存第二份开始时间；store 是 provider 内部的展示派生缓存，用 `useSyncExternalStore` 让非运行工具行不因 turnActivity 刷新而重渲染。
  - `turnActivity` 缺少 `toolCallId`（协议允许缺省）时无法定位工具行，不显示耗时。
- “中断并重试”：以当前轮次的真实用户输入（`userInput` 行，`origin=realUser`）的文本、附件和引用，通过既有 `sendText` 路径提交 `requestedDelivery: "startNow"`，由 CLI 原子停止当前轮并开始新轮（与 Cmd/Ctrl+Enter 立即发送同一路径）；找不到可重发输入时隐藏该按钮。
- “中断”：复用 `handleStop("button")`。
- “查看日志”：复用 `runExportLogsAction`（导出日志并在文件管理器中定位）；仅在 `platform.canOpenLocalFiles`（桌面）时显示，Web / 手机远控隐藏。
- i18n 命名空间：`chat.stall.*`（zh-CN / en-US 同步）。

## 验收

- shared：schema 接受合法 `turnActivity`、拒绝非法阶段字段、旧快照缺省为 undefined/null。
- CLI：TurnStarted 后为 `waiting_model`；工具 running 时为 `running_tool`；工具结束回到 `waiting_model`；5s 内的连续流式事件不重复发布；轮次结束清空；patch 不递增 revision。
- UI：59s 不显示；60s 提示；5min 警告与按钮；`running_tool` 不显示提示条，只在命中的运行中工具行尾显示耗时（59s 不显示、60s 显示“1 分钟”、非命中行与已完成行不显示、分组行按子工具 id 命中且展开后组头不重复）；有待处理交互不显示；live tail footer 带轮内容水平内边距。

## 1.5.1 回归

来源：1.5.0 实机截图（`docs/plans/2026-11-22-1.5.1-fixes-and-ycode-rename.md` 工作包 E 第 2–4 项）。

| 现象                                                  | 根因                                                                                                                                                                                          | 修复                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 提示条比轮内容更靠左                                  | `ConversationTimeline` 的 `data-v4-live-tail-footer` 容器只有 `pb-2`；轮内容的 `px-4 @md/conversation:px-6` 在 `ConversationTurnGroup` 的 `<section>` 上，footer 是其兄弟节点，拿不到该内边距 | footer 复用同一内边距常量                        |
| “正在执行 Bash，已 1 分钟”与上方“正在执行 curl …”重复 | `resolveConversationStallState` 对 `running_tool` 也返回 `tool` 提示，而运行中工具行本身已在表达“正在执行”                                                                                    | `running_tool` 返回 `none`；耗时改为工具行尾追加 |
| 提示用原始工具名 `Bash`                               | 提示直接显示 `activityPhase.toolName`（runtime 原始名），没有经过工具行的显示名映射                                                                                                           | 不再显示独立工具提示，工具名由工具行自身渲染     |
