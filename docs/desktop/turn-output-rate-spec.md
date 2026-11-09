# 回复输出速度（tokens/s）悬浮提示 Spec

> 来源：`docs/plans/2026-11-09-engine-composer-subagent-polish.md` W7、D5、R2-2、事实 F7。
> 范围：已完成轮次最后一条回复底部操作栏的时间元素悬浮提示；ZCode 原生引擎的逐调用 tokens/s 统计；Claude Code / Codex 外部引擎的输出 token 与耗时展示。

## 1. 产品规则

- 只在**已完成**的轮次（`turnHeader.state` 为 `completedSuccess` 或 `completedInterrupted`）上显示，挂在该轮最后一条回复的操作栏时间元素上；运行中、失败轮不显示。
- 鼠标悬停或键盘聚焦时间元素时显示提示；时间元素可通过 Tab 聚焦，提示内容同时作为可访问描述。
- 提示由已知字段按顺序拼接，缺失的段落省略；所有段落都缺失时不显示提示，时间元素保持原样（不可聚焦）：
  1. `48.2 tokens/s`：仅当 CLI 写入 `outputTps` 时显示（保留 1 位小数）。
  2. `输出 1,234 tokens`：`outputTokens > 0` 时显示（千分位按界面语言）；`reasoningTokens > 0` 时改为「输出 1,234 tokens（含思考 300）」。`outputTokens` 为 0 不显示：冷恢复从 transcript 合成的轮次 usage 恒为 0，不是真实输出量。
  3. `首字 1.1 秒`：仅当 `firstTokenMs` 已知时显示（保留 1 位小数）。
  4. `总耗时 23 秒`：`activeMs` 已知时显示，与「已工作 N」使用同一时长写法（`formatConversationWorkDuration`）。
- 时长单位沿用现有工作时长文案：中文单位前留空格（`23 秒`），英文缩写紧贴数字（`23s`）。
- 示例（原生，zh-CN）：`48.2 tokens/s · 输出 1,234 tokens · 首字 1.1 秒 · 总耗时 23 秒`；en-US：`48.2 tokens/s · Output 1,234 tokens · First token 1.1s · Total 23s`。
- 示例（Codex）：`输出 1,234 tokens（含思考 300）· 总耗时 23 秒`；Claude Code 不单独报告思考 token：`输出 1,234 tokens · 总耗时 23 秒`。
- 冷恢复（应用重启后从 transcript 重建）的历史轮次没有逐请求计时与 usage，只显示总耗时；不为历史轮次估算。
- **不估算**：没有准确数据就不显示 tokens/s，不能用整轮耗时、请求总耗时或 chunk 间隔代替生成时长。
- UI 不判断引擎类型；是否显示 tokens/s 完全由 CLI 投影是否写入 `outputTps` 决定。

## 2. 计算规则（ZCode 原生引擎）

数据源：runtime 每次物理模型请求完成时发布的 `ModelNetworkStatus(model_request_completed)`，只取 `querySource` 为 `main_turn`（或缺省）的请求；compact、标题、子智能体等旁路请求不计入。

逐调用：

- 生成时长 `generationMs = durationMs − timeToFirstContentMs`。两者来自同一请求时钟；首字为 adapter 观察到的首个文本、推理或工具参数输出。`generationMs ≤ 0` 视为缺数据。
- 分子（流式输出 token）：
  - 本次调用收到过非空推理 delta（`reasoningContentStreamed === true`），或 `reasoningTokens` 缺省 / 为 0：分子 = `outputTokens`（推理与正文都在生成时长内）。
  - `reasoningTokens > 0` 且明确没有收到推理 delta（`reasoningContentStreamed === false`，隐藏推理）：分子 = `outputTokens − reasoningTokens`，因为隐藏推理发生在首字之前，不在生成时长内。结果为负视为缺数据。
  - `reasoningTokens > 0` 但事件未记录 `reasoningContentStreamed`（旧事件）：无法判断推理是否在生成时长内，视为缺数据。
- 实现：`packages/shared/src/session-debug.ts` 的 `calculateModelCallOutputRate`，开发者工具逐调用 TPS 与本功能共用同一规则（`docs/context-cache-hit-rate.md` Output TPS 同步更新）。

整轮：

- `outputTps = Σ分子 ÷ Σ generationMs`（`aggregateTurnOutputRate`）。
- 轮内没有任何已完成的主链路调用，或**任何一次**已完成调用缺数据：整轮不写 `outputTps` / `generationMs` / `firstTokenMs`。
- 失败后被重试的物理请求不产生 `model_request_completed`，不计入分子与分母（它的输出不在任何已完成调用的生成时长内，也不在 `outputTokens` 中）。
- `firstTokenMs` = 轮内第一次已完成主链路调用的 `timeToFirstContentMs`。
- 只有成功结束（`TurnComplete.resultType === "success"`）或 queue drain 切轮收口的轮次写入这三个字段；中断、失败轮不写，避免用未完成调用之外的部分数据误导。

## 3. 外部引擎（Claude Code / Codex）

- 不显示 tokens/s（D5）。外部引擎只有整轮 `session/prompt` 的 usage，chunk 时间混入工具执行和隐藏推理。
- `outputTokens` 沿用整轮 usage；Codex ACP usage 的 `thoughtTokens` 由 adapter 保留为 `reasoningTokens`，经 `ModelComplete.usage.reasoningTokens` 累计进 `turnHeader.reasoningTokens`；Claude Code 不报告思考 token，不显示「含思考」。
- 耗时使用 `turnHeader.activeMs`（与原生相同的权威工时）。

### 3.1 R2-2 调查：本地 CLI 记录能否提供口径一致的逐调用数据

调查方式：只读脚本，仅读取 usage、时间戳、id 与内容块类型字段，不读取或记录正文（2026-11-09，本机）。

Claude Code（`~/.claude/projects/**/*.jsonl`，最近 60 个文件，版本 2.1.300–2.1.319，入口含 `claude-vscode`、`cli`、`sdk-ts`）：

- 每次 API 请求有一条 `api-request` 记录（时间戳≈请求发出），assistant 条目按内容块各写一条，以 `message.id` / `requestRef` 关联；同一请求各条目的 `usage.output_tokens` 一致（3664 个请求中 0 个不一致），`output_tokens_details.thinking_tokens` 给出思考 token。
- **没有首字时间**。条目时间戳是内容块结束（写盘）时间；只有 `thinking` 块带 `thinkingDurationMs`、`tool_use` 块带 `toolInputStreamMs`，`text` 块没有时长字段，另有 322 个 `tool_use` 块缺时长。首块为 `text` 或缺时长的请求约 8%，无法推出首字时间。
- `requestRef`、`apiBlockIndex`、`thinkingDurationMs`、`toolInputStreamMs` 都是未公开的内部字段，仅在近期版本出现；`thinkingDisplay` 为摘要模式时，流式显示的是思考摘要而计费 token 是完整思考，无法确认完整思考是否落在「首块开始 → 末块结束」区间内。

Codex（`~/.codex/sessions/**/rollout-*.jsonl`，38 个文件，版本 0.156.0–0.167.0-alpha）：

- `token_usage_record` 按 `response_id` 给出逐次响应的 `output_tokens` 与 `reasoning_output_tokens`；`event_msg:item_completed` 带 `started_at_ms` / `completed_at_ms`，但不带 `response_id`，只能按文件顺序把 item 归到下一条 usage 记录；部分 usage 记录前没有任何 item（各版本 15–87 条），0.162.0-alpha 版本的 item 完全没有 `started_at_ms`。
- 推理 item 的 `started_at_ms` 语义未公开：无法区分它是隐藏推理开始还是推理摘要开始流出，因而无法按第 2 节规则决定分子是否扣除 `reasoning_output_tokens`。

映射到 YCode 轮次：两者都需要 CLI 读取用户主目录下的私有记录，按会话 id 与时间窗口启发式匹配 `session/prompt`；记录异步落盘、路径受 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 与 cwd 编码影响，远程工作区不可用，格式随 adapter 版本变化且无契约可测。

**结论**：无法证明本地记录与第 2 节口径一致（缺首字时间、推理时段语义未知、逐请求关联依赖内部字段与顺序），按 R2-2 保持 D5：外部引擎不显示 tokens/s。若将来 ACP adapter 在 `session/update` 或 prompt 结果里提供逐请求的首字与结束时间，再按第 2 节规则评估。

## 4. 协议与状态所有者

`turnHeader` 行新增可选字段（只增不改，`packages/shared/src/zcode-protocol-v4/rows.ts` 严格校验）：

| 字段              | 类型       | 写入方   | 时机                                                      |
| ----------------- | ---------- | -------- | --------------------------------------------------------- |
| `outputTps`       | 非负有限数 | CLI 投影 | 轮次成功结束 / 切轮收口                                   |
| `generationMs`    | 非负有限数 | CLI 投影 | 同上                                                      |
| `firstTokenMs`    | 非负有限数 | CLI 投影 | 同上                                                      |
| `reasoningTokens` | 非负整数   | CLI 投影 | 每次主链路 `ModelComplete` 累计（与 `outputTokens` 同源） |

runtime 侧：`ModelRequestCompletedStatusEvent` 新增可选 `reasoningContentStreamed?: boolean`，由 adapter（`runner-stream.ts`）在本次物理请求收到非空 `reasoning_delta` 时置 `true`，否则为 `false`。

```text
adapter runner-stream ── model_request_completed{usage,durationMs,timeToFirstContentMs,reasoningContentStreamed}
        │（每次物理请求一次，主链路 querySource=main_turn）
        ▼
CLI ProductProjection（唯一所有者）── 按 productTurnId 收集逐调用记录（侧表，随 clone/adopt 复制）
        │ ModelComplete ──► turnHeader.outputTokens / reasoningTokens 累计
        │ TurnComplete(success) / splitProductTurn ──► aggregateTurnOutputRate ──► turnHeader.outputTps/generationMs/firstTokenMs
        ▼
snapshot / delta（desktop continuous 与冷恢复重放同一事件序列，结果一致）
        ▼
Renderer ConversationTurnGroup ── 只读 unit.header ──► ConversationAssistantTextActions 时间元素 tooltip
```

- Renderer 不保存、不推算任何速度状态；冷恢复按持久化事件重放得到相同字段。
- 侧表在 `TurnComplete` / `TurnError` / 切轮后删除对应轮的记录，不跨轮泄漏。

## 5. 验收场景

1. 原生多次调用：两次调用（120 tokens / 生成 2s，80 tokens / 生成 2s）→ 50 tokens/s，首字取第一次调用。
2. 隐藏推理：`outputTokens=300, reasoningTokens=200, reasoningContentStreamed=false`，生成 1s → 100 tokens/s。
3. 推理可见：同上但 `reasoningContentStreamed=true` → 300 tokens/s。
4. 任一调用缺 `timeToFirstContentMs` 或 `generationMs ≤ 0` → 整轮无 tokens/s，其余段落照常显示。
5. 外部引擎轮：无 `model_request_completed`，提示只含输出 tokens（Codex 含思考）与总耗时。
6. 运行中、失败轮不显示提示；时间元素可 Tab 聚焦并显示同一提示。
7. 中英文文案：`zh-CN` 与 `en-US` 都有对应条目。
8. 人工核对：同一轮与开发者工具逐调用 TPS 使用同一规则，可手算一致。
