# turn-stall

轮次无响应提示（规则见 [轮次无响应提示](../../../../docs/chat/turn-stall-indicator.md)）。

- 事实来源：runtime `ProductProjection` 下发的 `snapshot.turnActivity`（`lastActivityAt` / `phaseStartedAt` / `activityPhase`）。本模块只做纯派生，不保存第二份活动时间；旧 runtime 不下发时不显示。
- `resolveConversationStallState`：`waiting_model` 无输出 ≥60s → `hint`，≥5min → `warning`；`running_tool` 执行 ≥60s → `tool`（不升级为警告）；非运行或有待处理交互 → `none`。
- `ConversationStallNotice`：仅在运行且有 `turnActivity` 时每 5s tick；“中断并重试”“中断”“查看日志”全部委托宿主（SessionPane），不自动中断或重试。
