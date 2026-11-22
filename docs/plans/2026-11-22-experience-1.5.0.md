# 1.5.0 体验改进计划（已与用户确认）

来源：2026-11-22 grilling 会话。所有决策用户已确认“按推荐”。每个工作包先写/更新 spec，再写测试，再实现。
美学对标 Codex：只调整本次改到的界面，复用现有设计 token（`packages/ui/src/styles.css`、`DESIGN.md`），不做全局重绘。

## 工作包 A：大文件预览 + 无响应提示 + 更改卡片

### A1 预览上限 256KB → 50MB
- 现状：`packages/services/src/file/fileService.ts` `MAX_TEXT_READ_BYTES=256K`，`packages/ui/src/lib/codeViewer.ts` `FILE_VIEWER_MAX_TEXT_BYTES`，`PreviewPane.tsx` 截断即整体丢弃（`resolvePreviewPaneTextFileResult`）。
- 目标：
  - ≤1MB：正常预览（Shiki 高亮、Markdown/SVG/HTML 预览）。
  - 1MB–50MB：大文件模式，按 1MB 分块（`readTextFile` 的 `offset`/`length`）按需读取，虚拟滚动纯文本，关闭高亮；顶部提示“大文件，已简化显示”与“仍然渲染”按钮。
  - >50MB：提示使用外部编辑器打开（保留现有入口）。
  - 本地与远程（SSH/WSL/Docker 工作区 RPC）同一上限；单次 RPC 读取上限提升到 1MB 级而非 50MB。
  - 分块边界需处理 UTF-8 多字节截断。
  - HTML 文件默认显示源码，提供“预览”切换。
- 更新 `docs/ui/preview-pane.md`。

### A2 无响应提示
- 现状：外部引擎（Claude/Codex ACP）轮次无 idle 检测；`apps/zcode-cli/packages/adapters/src/external-engine/connection.ts` `session/prompt` 无超时。“工作中 X 分 Y 秒”只是墙钟。
- 目标：
  - runtime 是唯一所有者：在轮次快照中记录 `lastActivityAt`（最近一次引擎事件：文本/思考/工具调用/工具结果）与当前阶段 `activityPhase`（`waiting_model` | `running_tool` + 工具名）。协议改动同步 `packages/shared/src/zcode-protocol/index.ts`，带严格类型与运行时校验；重连/重放后仍可得到。
  - UI 仅派生展示：无输出 ≥60s 显示“Claude 已 N 分钟无输出”+ 当前阶段；≥5min 升级为警告样式，主按钮“中断并重试”，另有“中断”“查看日志”。
  - 工具执行中（`running_tool`）不视为无响应，显示“正在执行 <工具>，已 N 分钟”。
  - 不自动重试、不自动中断。
  - 原生引擎同样适用（有事件即刷新）。

### A3 更改条数
- 现状：`ConversationStatusPanel.tsx` 顶部胶囊显示工作区 git worktree 全量 diff（与对话无关）。
- 目标：从顶部胶囊移除该指标（Git 面板/展开环境区仍可看工作区全部更改）。在每轮助手回复末尾显示 Codex 式“已更改 N 个文件 +x −y”卡片（按该轮实际文件编辑；该轮无改动不显示），点击打开该轮 diff 审阅。

## 工作包 B：错误 UI + 模型名/思考程度

### B1 错误 UI
- 现状：`packages/ui/src/components/ai-elements/error-diagnostics.tsx`（`TurnFailureRow`/`ErrorDiagnostics`）与 `packages/ui/src/ChatErrorBanner.tsx` 两套样式并可能重复展示。
- 目标：
  - 轮内错误一行：⚠ 图标 + 一句人话 + “重试” + “详情”展开箭头；展开为等宽灰底卡片：错误码、HTTP 状态、请求 ID/Trace ID、原始报错，右上角“复制全部”。
  - 常见错误码映射中文解释+建议（401/403 鉴权、429 限流、529/overloaded、超时、网络断开、上下文过长等），en-US 同步。
  - Composer 横幅只承载非轮次错误（引擎未配置、连接断开等）；同一错误不双处出现。
  - 不做全局错误日志面板。

### B2 模型名与思考程度
- 模型名在显示层去掉 `Claude ` 前缀（适配器 catalog 原始值不改），如 `Opus 4.7`、`Sonnet 4.6`；Codex 保持 `GPT-5.5`。
- 思考程度按钮上缩写（≤5 字母）：Minimal→`Min`、Low→`Low`、Medium→`Med`、High→`High`、Extra high/xhigh→`XHigh`、Max→`Max`、Ultra→`Ultra`、Default→`Auto`、Off/On 不变。下拉菜单展开显示全称+说明。
- 组合展示：`Opus 4.7 XHigh`，中间无 `·`，只用一个窄间距（不额外占位）。
- 涉及：`packages/ui/src/external-engine/engineOptionDisplay.ts`、`packages/ui/src/chat-input-toolbar/thoughtLevelLabels.ts`、`EngineConfigPicker.tsx`、`EngineControls.tsx`、i18n。更新已有测试（aed5fe6c/51f4fcbe 的断言）。

## 工作包 C：角标数字 + 通知音 + 自动更新

### C1 角标
- 现状：`packages/desktop/src/main/unreadBadge.ts` Windows 叠加图标只画红点。
- 目标：显示数字（1–9，>9 显示 `9+`）；计数 = 未读已完成任务 + 等待用户操作（审批/提问）的任务；打开/聚焦该任务即清除。Windows 叠加图标绘制数字（16/32px，清晰可读）；macOS `app.dock.setBadge`/`setBadgeCount`；Linux `setBadgeCount`。托盘同步。

### C2 通知音
- 保留现有 `task-notification-pop.mp3` 作为默认；新增 5 种合成音（清脆、柔和、木鱼、水滴、双音）+ 静音。音频由仓库内脚本合成生成（不引入第三方素材），可试听。
- 两类事件分别选择：“任务完成”、“需要你操作（审批/提问/出错）”。
- 默认仅窗口不在前台时响，开关可改为总是响。
- 设置从 localStorage 迁移为随应用设置持久化（多窗口一致），保留旧 key 迁移。

### C3 自动更新
- 现状：`packages/desktop/src/main/github-update/` 已启动+每 6h 自动检查，但下载需手动，无开关。
- 目标：新增设置“自动下载更新”（默认开）与“自动检查更新”开关；检查到新版本后后台下载并校验，完成后标题栏/侧栏显示“重启以更新”，不强制重启；退出应用时安装（Windows 运行安装器、macOS helper）。更新 `CONTRACT.md`。

## 工作包 D：使用统计（本机 Claude Code / Codex）
- 现状：`packages/ui/src/settings/UsageStatsSection.tsx` + `packages/services/src/usage-stats/usageStatsService.ts`，数据仅来自 CLI agent-db；外部引擎 token 可能未写入 `model_usage`。
- 数据源（仅本机）：
  - ZCode 原生引擎：保持 agent-db。
  - Claude Code：`~/.claude/projects/*/*.jsonl` + `<project>/<session>/subagents/*.jsonl` + `subagents/workflows/wf_*/*.jsonl`；只取 `type=assistant` 行的 `message.usage`（input/output/cache_read/cache_creation，含 `ephemeral_1h_input_tokens`）；按 `message.id`（+`requestId` 若存在）去重，同 id 优先有 `stop_reason`，否则取 output 更大。尊重 `CLAUDE_CONFIG_DIR`。
  - Codex：`~/.codex/sessions/YYYY/MM/DD/*.jsonl` + `~/.codex/archived_sessions/*.jsonl`；`session_meta` 取 thread/cwd，`turn_context` 取模型，`event_msg type=token_count` 优先 `info.last_token_usage`，否则 `total_token_usage` 高水位差；跳过重复签名事件；cached 不超过 input。尊重 `CODEX_HOME`。
  - Claude/Codex 的 token 一律以本地日志为准；通过会话 ID 标注 ZCode 启动的为“ZCode”来源，其余为“Claude Code CLI”/“Codex CLI”。避免与 agent-db 双计。
- 扫描：仅在打开统计页时增量扫描（每文件游标：mtime、size/字节偏移、尾部指纹），停留时每 30s 刷新；游标与缓存存于应用数据目录本地文件；异步 IO，不阻塞。
- 费用：内置价格表（每百万 token：input/output/cache read/cache write；Claude 1h 写入另计），按模型可手动改价；“同步价格”按钮手动从 models.dev 拉取（默认不联网）；界面标注“按 API 价格估算”。模型 ID 归一化（去前缀/日期/[1m] 等）。
- 视图：扩展现有统计页：来源筛选（全部/ZCode/Claude Code/Codex）、时间范围（今天/7天/30天/全部/自定义）；卡片：费用、请求数、Token、缓存命中率；趋势图可切换 Tokens/请求/费用；53 周热力图；Tab：按模型、按项目（cwd）、请求明细、定价。ZCode 专属指标（会话、工具错误率等）在非 ZCode 来源时隐藏。
- 不统计远程工作区所在机器的日志。

## 交付
- 4 个工作包并行在独立 worktree 分支实现，合并到 `feat/1.5.0-experience`，版本号提升到 1.5.0，推送到 OpenX123/ZCode，CI 构建并发布，在本机安装。
