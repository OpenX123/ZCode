# subagent-display

UX03：正常完成与失败/停止一样，从父行 `summaryText` 纯派生 `resultSummary`（空白或等于任务标题时省略）。子任务详情只读 child 自身可回放 message/part，不从父摘要拼出第二份结果。

多智能体展示：头像（瓦片脸 + 类型轮廓）、胶囊头像串、对话行内子智能体行（1.4，Codex 式每个子智能体一行；无子会话时为旧派发行 / Agent 卡）、右侧"子智能体"Tab 的详情头部（返回目录箭头）与只读提示。完整规则见 [多智能体展示规范](../../../../docs/desktop/multi-agent-display-spec.md)。

- 只读投影：父会话 `snapshot.subagents` / `backgroundWorks` / 时间线行，子会话 `control` / 行窗口。不保存运行态、不按引擎分支；W8 只读取协议新增的可选 `model` / `effort` / `toolCallCount`。
- 头像序号由 `buildSubagentAvatarIndex(childSessionIds)` 派生，未登记成员用 `resolveSubagentAvatarIndexes` 的临时序号；颜色从不表示状态。
- `groupConsecutiveAgentSpawns` 合并同一轮相邻派发：任一成员有子会话 → `workCard`（1 个也成组，由 `SubagentWorkRows` 渲染为无外框的连续行），否则 ≥2 个 → `sentence`；只用于实时对话时间线。
- 行：头像（运行中动态）+ 名称（标题优先）+ 类型灰色小标签（`subagentTypeLabel`：非默认 `subagent` 且不同名才显示）+ 状态（运行中带用时）；失败/已停止原因一行灰字；可停时行尾单个停止。不再有工作卡折叠、"停止全部"、模型/步骤数。
- `useSubagentWorkLiveIndex` 从父会话 `running[]` 与 `backgroundWorks` 派生 waiting / blocked 与可停 workId，内容不变时引用稳定；停止规则 `resolveSubagentStopWorkId` 与详情头部共用。
- 行组不写 disclosure override；完成轮次折叠时只提升含活动或失败成员的行组。打开子会话复用 `onOpenSubagentSession`（宿主打开右侧唯一"子智能体"Tab 并选中），停止复用父会话 `cancelBackgroundWork`，不新增命令。

- `SubagentActivityButton` 位于现有输入工具栏，读取同一父 manifest，复用 isSubagentStatusActive 判断；仅有活动成员时显示各活动状态与结束数量，全部结束不渲染。不关闭详情、不取消工作，点击复用子任务目录。不持有执行状态，不依赖工作流胶囊显隐。
- 成功成员只显示“已完成”，整行原生按钮打开只读详情；失败/已停止保留“原因”。
- 输入区只计算 manifest 已登记成员；协议 running[] 无 pending。未登记 pending 仍在主对话工作卡保持活动，不显示空目录、不造 child 或提前计数。
- 名称解析统一为任务名优先；等待不显示用时，失败/停止只计为结束。
