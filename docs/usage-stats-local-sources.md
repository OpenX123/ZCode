# 使用统计：本机多来源（ZCode / Claude Code / Codex）

状态：accepted（1.5.0 工作包 D，决策见 `docs/plans/2026-11-22-experience-1.5.0.md`）。
本文扩展 [App Usage / Coding Plan 拆分](usage-stats-app-coding-plan-split.md) 中的 App Usage 链路；
Coding Plan 链路不变。

## 1. 产品规则

- 只统计**本机**数据：Host 进程所在机器上的 ZCode agent-db、Claude Code 日志、Codex 日志。
  远程工作区所在机器的日志不读取；Web 服务端模式下“本机”指运行服务端的机器。
- 三个来源：
  - **ZCode 原生**：CLI usage store（`model_usage`）。保留期沿用 CLI 的 30 天；Host 侧缓存会
    保留已见过的按日聚合，超过 30 天的历史在缓存中继续可见（见 §4.4）。
  - **Claude Code**：`<claudeDir>/projects/**.jsonl`。
  - **Codex**：`<codexHome>/sessions/**.jsonl` 与 `<codexHome>/archived_sessions/*.jsonl`。
- Claude Code / Codex 的 token **一律以本地日志为准**。ZCode 外部引擎会话（engine ≠ `zcode`）不写
  `model_usage`（外部引擎轮次只发 `ModelComplete` 事件、只写 `turn_usage`），因此不会与日志双计。
- 归属（launcher）：ZCode 会话库 `session.external_session_id` 记录 ACP `session/new` 返回的原生会话 ID：
  - Claude Code（claude-agent-acp）：ACP session id = Claude Code `sessionId`（jsonl 行内 `sessionId`，
    也是 `projects/<project>/<sessionId>.jsonl` 文件名）。
  - Codex（codex-acp）：ACP session id = Codex thread id（`session_meta.payload.id`）。
  - 命中映射 → 来源标签 `ZCode · Claude Code` / `ZCode · Codex`；否则 `Claude Code CLI` / `Codex CLI`。
  - Claude 子代理日志（`<sessionId>/subagents/...`）按行内 `sessionId`，缺失时按父目录名归属到父会话。
- 来源筛选：
  - `全部`：三来源合计，每条请求只计一次。
  - `ZCode`：ZCode 原生 + ZCode 启动的 Claude Code / Codex 会话。
  - `Claude Code`：全部 Claude Code 日志（含 ZCode 启动的）。
  - `Codex`：全部 Codex 日志（含 ZCode 启动的）。
- 时间范围：`今天`、`7 天`、`30 天`、`全部`、`自定义`（起止自然日，按调用端时区）。默认 `7 天`。
- 费用：`按 API 价格估算`（USD），见 §5。没有价格的模型费用记为未定价，不按 0 美元误导展示。
- ZCode 专属指标（会话数、轮次、工具调用、工具错误率、首 token 时间、最长会话）只在来源为
  `全部`/`ZCode` 时显示，并标注“仅 ZCode 原生会话”；数据仍来自既有 `getAppUsageSnapshot`，
  范围映射：今天/7 天 → `7d`，30 天 → `30d`，全部/自定义 → `all`，标题显示实际窗口。

## 2. 界面

```text
使用统计 [ App Usage | Coding Plan ... ]
[ 全部 | ZCode | Claude Code | Codex ]          [ 今天 | 7 天 | 30 天 | 全部 | 自定义 ] [↻]
（自定义时显示起止日期输入）
[ 费用 $12.34 ] [ 请求 1.2K ] [ Token 35M ] [ 缓存命中 82% ]      按 API 价格估算
[ 用量趋势                                    Tokens | 请求 | 费用 ]
[ Token 活动（53 周）                           每日 | 每周 | 累计 ]
[ 按模型 | 按项目 | 请求明细 | 定价 ]
[ ZCode 运行指标（仅 ZCode 原生会话） ]   ← 来源为 全部/ZCode 时
```

- 卡片：费用（含未定价提示）、请求数、Token（输入/输出/缓存小字）、缓存命中率
  = cacheRead / (input + cacheRead + cacheWrite)。
- 趋势图按日展示所选指标，范围内连续补 0；`全部` 从最早有数据的日期开始（最多 400 天）。
- 热力图固定最近 53 个自然周，周日起始，受来源筛选影响、不受时间范围影响；tooltip 显示 Token 与请求数。
- 按模型：模型（归一化 ID）、请求、输入、输出、缓存读、缓存写、费用、占比。
- 按项目：cwd（ZCode 原生取会话目录）、请求、Token、费用、最近活动时间。
- 请求明细：最近 200 条（按时间倒序），时间、来源标签、模型、项目、输入/输出/缓存、费用。ZCode 原生只有
  按日聚合，不进入请求明细（表头注明）。
- 定价：本范围用到的模型 + 已覆盖的模型；列 input / output / cache read / cache write / 1h cache write
  （每百万 token，USD），来源标记 内置 / 已同步 / 手动；可编辑手动价、恢复默认；按钮“同步价格”。
- 复用设计 token、`text-ui-*`、pill tabs（`USAGE_STATS_TABS_*`）；手机 Web 下工具栏换行、表格横向滚动容器内滚动。

## 3. 状态所有者与接口

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| model_usage / session 映射 | CLI usage store | 只读查询，经 `v4/usage/stats` 附带 `usageFacts`、`externalSessions` |
| 日志游标、解析出的请求、映射缓存 | Host `LocalUsageScanner`（services） | 内存索引 + `~/.zcode/v2/usage-stats/local-usage-cache.json` |
| 价格覆盖 / 同步价格 | Host `ModelPricingStore` | `~/.zcode/v2/usage-stats/model-pricing.json` |
| 选中来源、范围、tab | Renderer 组件局部状态 | 非服务端事实 |

`IUsageStatsService` 新增（RPC 两端都用 `@zcode/shared` zod schema 校验）：

- `getLocalUsageSnapshot(request: LocalUsageRequest): Promise<LocalUsageSnapshot>`
- `setModelPriceOverride(request: { modelId: string; price: ModelPrice | null }): Promise<void>`
- `syncModelPrices(): Promise<ModelPriceSyncResult>`（唯一联网入口，用户点击触发）

```text
Renderer(LocalUsagePanel)          Host UsageStatsService            CLI usage store
  mount / 30s tick / ↻ ───────────▶ getLocalUsageSnapshot(req)
                                     ├─ scanner.scan()（单飞；5s 内复用上次结果）
                                     │   ├─ zcodeAgent.getAppUsageStats(all) ───▶ queryAppUsage
                                     │   │     ◀── usageFacts + externalSessions ──┘
                                     │   ├─ 逐文件增量读取 Claude/Codex jsonl
                                     │   └─ 写 cache 文件（原子写）
                                     └─ aggregate(index, mapping, pricing, req)
  ◀──────────── LocalUsageSnapshot（zod 校验）
  unmount / 页面隐藏 → 停止定时器（不再扫描）
```

- 扫描只由 `getLocalUsageSnapshot` 触发：统计页打开时首次加载、停留期间每 30s、手动刷新。页面不可见
  （`document.hidden`）时跳过 tick。没有任何后台常驻扫描。
- 并发：同一 Host 同时只有一次扫描，后来者 await 同一个 promise；扫描结束 5s 内的请求直接复用索引。
- 请求版本号：Renderer 丢弃过期响应（与 `useAppUsageStats` 相同的 requestVersion 规则）。
- CLI 不可用（无活动 workspace）时：ZCode 原生用缓存中的按日聚合，映射用缓存中的映射，快照
  `scan.zcodeNativeAvailable=false`，界面提示“ZCode 原生用量暂不可用”。

## 4. 日志解析与去重（参考 ccusage / cc-switch 规则）

### 4.1 目录

- Claude：`CLAUDE_CONFIG_DIR`（可逗号分隔多个）下的 `projects`；未设置时 `~/.claude/projects` 与
  `~/.config/claude/projects`（存在者）。递归最多 5 层收集 `*.jsonl`，覆盖
  `projects/*/*.jsonl`、`projects/*/<session>/subagents/*.jsonl`、`.../subagents/workflows/wf_*/*.jsonl`。
- Codex：`CODEX_HOME` 或 `~/.codex`；`sessions/**/*.jsonl`（YYYY/MM/DD）与 `archived_sessions/*.jsonl`。
- home 解析：`ZCODE_DESKTOP_HOME_DIR` → `HOME` → `USERPROFILE` → `os.homedir()`（与 settingService 一致）。

### 4.2 Claude Code

- 只取 `type == "assistant"` 且 `message.usage` 存在的行；`message.model == "<synthetic>"` 跳过。
- 字段：`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`；
  `cache_creation.ephemeral_1h_input_tokens` 计为 1h 写入，其余缓存写入计为 5m。
- 去重键：`message.id` + `requestId`（都存在时），只有 `message.id` 时用它；都没有则不去重。
  同键多行：优先 `stop_reason` 非空者，否则取 `output_tokens` 更大者。去重跨文件生效
  （resume / fork 会把旧消息复制到新文件）。
- 时间 `timestamp`（ISO）；cwd 取行内 `cwd`；会话取行内 `sessionId`。

### 4.3 Codex

- `session_meta`：`payload.id` → thread id，`payload.cwd` → cwd。
- `turn_context`：`payload.model` → 当前模型（之后的 token_count 使用）。缺失时回退 `gpt-5`。
- `event_msg` 且 `payload.type == "token_count"`：
  - 签名 = `total_token_usage` 与 `last_token_usage` 的 JSON；与上一条签名相同则跳过（重复事件）。
  - 优先 `info.last_token_usage`；没有时用 `total_token_usage` 相对上一次高水位的差（总量回退视为重置，
    取当次总量）。
  - `cached_input_tokens` 不超过 `input_tokens`；未缓存输入 = input − cached；输出 = `output_tokens`
    （`reasoning_output_tokens` 已包含在输出中，仅作明细）。
  - 全零 usage 跳过。
- 跨文件去重键：`timestamp` + total 签名（fork 复制历史事件时时间戳与总量不变）。

### 4.4 增量游标与缓存文件

- 每文件游标：`mtimeMs`、`size`、`offset`（最后一个完整行结束的字节位置）、`tailHash`
  （`offset` 前最多 256 字节的 sha1）、解析器状态（Codex：thread/cwd/model/上次总量/上次签名）。
- 规则：文件不存在 → 删除该文件记录；`size == 游标 size && mtime 相同` → 跳过；
  `size >= offset` 且尾部指纹一致 → 从 `offset` 继续读；否则（截断、改写）→ 该文件全量重扫。
- 读取：`fs.createReadStream` 流式按字节切行，不整文件读入；单行超过 16MB 丢弃至下一换行并计入
  `malformedLines`；未以换行结尾的尾行不推进游标（等待写完）。预过滤：Claude 行不含 `"usage"`、Codex 行不含
  `token_count` / `turn_context` / `session_meta` 时不做 JSON.parse。JSON 损坏或 schema 不符的行计入
  `malformedLines` 并跳过。
- 缓存文件：版本号 + 字符串表（模型、cwd、会话）+ 每文件游标与紧凑记录 + ZCode 按日聚合 + 外部会话映射。
  zod 校验失败或版本不符 → 丢弃缓存并全量重扫。写入使用原子写（临时文件 + rename）。
- ZCode 原生按日聚合合并：同一日期取“请求数更大”的一份（CLI 30 天裁剪只会让旧日期变少）。
  因此 agent-db 被裁剪或清空后，缓存中已见过的日期仍保留（删除 `local-usage-cache.json` 可重置）。

## 5. 价格

- 内置价格表（USD / 百万 token）：input、output、cacheRead、cacheWrite（5m）、cacheWrite1h（Claude）。
  覆盖 Claude（Opus 4/4.1、Opus 4.5+、Sonnet 3.7/4/4.5、Haiku 3.5/4.5）、OpenAI GPT-5 系列（含 codex/mini）、
  GLM 4.5/4.6/4.7。表外模型为“未定价”。
- 模型 ID 归一化：小写；去掉 `provider/` 前缀与 `us.anthropic.` / `anthropic.` 等区域前缀；去掉 `[1m]`
  等方括号后缀、`-v1:0`、`@20250514` / `-20250514` 日期后缀、`-latest`；Claude 版本 `4-5` → `4.5`、
  `claude-3-5-sonnet` → `claude-3.5-sonnet`。
- 查价：精确匹配 → 以 `-` 为边界的最长前缀匹配（`gpt-5.1-codex-max` → `gpt-5.1-codex`）。
- 优先级：手动覆盖 > 已同步（models.dev）> 内置。
- “同步价格”：仅用户点击时 `GET https://models.dev/api.json`（15s 超时），读取 anthropic / openai / zai /
  zhipuai 提供商的 `cost.{input,output,cache_read,cache_write}`；Claude 的 1h 写入 = 2 × input。
  失败保持原价格并提示错误，不自动重试、不定时联网。
- 费用 = Σ(tokens × 单价) / 1e6；ZCode 原生 input 为含缓存总量，计价时未缓存输入 = input − cacheRead − cacheWrite（不小于 0）。

## 6. 验收场景

| ID | 场景 | 断言 |
| --- | --- | --- |
| LU-01 | Claude 同 message.id 流式多行 + resume 复制到新文件 | 只计一次，取 stop_reason 行 |
| LU-02 | Claude 1h 缓存写入 | 1h 与 5m 分开计价 |
| LU-03 | Codex 重复 token_count / 只有 total | 跳过重复，按高水位差计 |
| LU-04 | Codex cached > input | cached 截断为 input |
| LU-05 | 损坏行、超长行、未写完尾行 | 跳过并计数，游标停在最后完整行 |
| LU-06 | 文件追加 / 截断重写 | 追加只读新增字节；截断全量重扫 |
| LU-07 | ZCode 启动的 Claude / Codex 会话 | 标注 ZCode，筛选 ZCode 包含，Claude Code 筛选也包含 |
| LU-08 | CLI 不可用 | 使用缓存映射与按日聚合，提示不可用 |
| LU-09 | 模型 ID 归一化与前缀查价 | 见单测 |
| LU-10 | 手动改价 / 恢复默认 / 同步价格 | 优先级正确，同步只在调用时发生 |
| LU-11 | UI 来源筛选 | 非 ZCode 来源隐藏 ZCode 运行指标 |
| LU-12 | 统计页停留 | 30s 刷新，卸载后不再请求 |

测试一律使用合成 fixture jsonl（`packages/services/test/fixtures/local-usage/`），不含真实用户数据。
