# turn-stall

轮次无响应提示（规则见 [轮次无响应提示](../../../../docs/chat/turn-stall-indicator.md)）。

- 事实来源：runtime `ProductProjection` 下发的 `snapshot.turnActivity`（`lastActivityAt` / `phaseStartedAt` / `activityPhase`）。本模块只做纯派生，不保存第二份活动时间；旧 runtime 不下发时不显示。
- `resolveConversationStallState`：`waiting_model` 无输出 ≥60s → `hint`，≥5min → `warning`；`running_tool` → `none`（1.5.1 起不出独立提示条）；非运行或有待处理交互 → `none`。
- `RunningToolActivityProvider` / `useRunningToolElapsedLabel`：`SessionPane` 用 provider 包住时间线，provider 从 `turnActivity` 派生当前运行工具 `{toolCallId, phaseStartedAt}`；`ToolLayout` 在运行态按自身（或分组子工具）id 订阅，命中且 ≥60s 时在行尾显示「N 分钟」。provider 内部 store 只是派生缓存，不是第二份事实。
- `ConversationStallNotice`：仅在运行且有 `turnActivity` 时每 5s tick；“中断并重试”“中断”“查看日志”全部委托宿主（SessionPane），不自动中断或重试。
