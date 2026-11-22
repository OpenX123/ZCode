# 轮次无响应提示（1.5.0）

## 背景

外部引擎（Claude Code / Codex ACP）轮次没有 idle 检测，`session/prompt` 也没有超时；对话区的“工作中 X 分 Y 秒”只是墙钟，用户无法区分“模型在长时间思考 / 工具在跑”和“连接已卡死”。本规范新增由 runtime 统一记录的轮次活动事实，并据此在 UI 上派生无响应提示。

## 产品规则

- 无输出时间 = `now - turnActivity.lastActivityAt`。
- 阶段 `waiting_model`：
  - 无输出 `< 60s`：不显示。
  - `≥ 60s`：提示行“{engine} 已 N 分钟无输出 · 等待模型响应”（次要文字色）。
  - `≥ 5min`：升级为警告样式（`warning-surface`），主按钮“中断并重试”，次按钮“中断”“查看日志”。
- 阶段 `running_tool`：不视为无响应。工具执行 `≥ 60s` 时显示“正在执行 {tool}，已 N 分钟”，不升级为警告，不显示按钮。
- 存在待处理交互（审批 / 提问，`pendingInteractions` 非空）或轮次不在 `running`：不显示。
- 不自动重试、不自动中断。
- 原生引擎与外部引擎同样适用：任何引擎事件都会刷新 `lastActivityAt`。
- 旧 runtime 不下发 `turnActivity` 时不显示提示（不做 UI 端推测）。

N 为向下取整的分钟数（至少 1）。`{engine}` 取 `ENGINE_LABELS`（YCode / Claude Code / Codex）。

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

- 派生函数：`packages/ui/src/v4/conversationStallState.ts` `resolveConversationStallState`（纯函数，可单测）。
- 组件：`packages/ui/src/v4/ConversationStallNotice.tsx`，由 `SessionPane` 作为 `ConversationTimeline` 的 live tail 附加内容渲染在运行中轮次末尾；组件只在 `turnActivity` 非空时每 5s 自行 tick。
- “中断并重试”：以当前轮次的真实用户输入（`userInput` 行，`origin=realUser`）的文本、附件和引用，通过既有 `sendText` 路径提交 `requestedDelivery: "startNow"`，由 CLI 原子停止当前轮并开始新轮（与 Cmd/Ctrl+Enter 立即发送同一路径）；找不到可重发输入时隐藏该按钮。
- “中断”：复用 `handleStop("button")`。
- “查看日志”：复用 `runExportLogsAction`（导出日志并在文件管理器中定位）；平台不支持导出日志时隐藏。
- i18n 命名空间：`chat.stall.*`（zh-CN / en-US 同步）。

## 验收

- shared：schema 接受合法 `turnActivity`、拒绝非法阶段字段、旧快照缺省为 undefined/null。
- CLI：TurnStarted 后为 `waiting_model`；工具 running 时为 `running_tool`；工具结束回到 `waiting_model`；5s 内的连续流式事件不重复发布；轮次结束清空；patch 不递增 revision。
- UI：59s 不显示；60s 提示；5min 警告与按钮；`running_tool` 显示工具文案且不警告；有待处理交互不显示。
