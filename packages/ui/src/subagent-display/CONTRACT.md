# subagent-display

UX03：正常完成与失败/停止一样，从父行 `summaryText` 纯派生 `resultSummary`（空白或等于任务标题时省略）。子任务详情只读 child 自身可回放 message/part，不从父摘要拼出第二份结果。

多智能体展示：头像（瓦片脸 + 类型轮廓）、胶囊头像串、对话行内 Subagent 工作卡（无子会话时为旧派发行 / Agent 卡）、右侧详情头部与只读提示。完整规则见 [多智能体展示规范](../../../../docs/desktop/multi-agent-display-spec.md)。

- 只读投影：父会话 `snapshot.subagents` / `backgroundWorks` / 时间线行，子会话 `control` / 行窗口。不保存运行态、不按引擎分支；W8 只读取协议新增的可选 `model` / `effort` / `toolCallCount`。
- 头像序号由 `buildSubagentAvatarIndex(childSessionIds)` 派生，未登记成员用 `resolveSubagentAvatarIndexes` 的临时序号；颜色从不表示状态。
- `groupConsecutiveAgentSpawns` 合并同一轮相邻派发：任一成员有子会话 → `workCard`（1 个也成组），否则 ≥2 个 → `sentence`；只用于实时对话时间线。
- `useSubagentWorkLiveIndex` 从父会话 `running[]` 与 `backgroundWorks` 派生 waiting / blocked 与可停 workId，内容不变时引用稳定；停止规则 `resolveSubagentStopWorkId` 与详情头部共用。
- UX08 工作卡通过独立 disclosure UI 入口只存手动 override，完整 scope + turn + 真实 toolCallId 隔离；默认 active 展开/ended 收起，生命周期不覆盖手动意图。外层历史共同订阅，仅提升活动、失败或手动打开的相关卡；失败原因收起仍可见。打开子会话复用 `onOpenSubagentSession`，停止与"停止全部"逐个复用父会话 `cancelBackgroundWork`（D7），不新增命令。

- `SubagentActivityButton` 位于现有输入工具栏，读取同一父 manifest，复用 isSubagentStatusActive 判断；仅有活动成员时显示各活动状态与结束数量，全部结束不渲染。不关闭详情、不取消工作，点击复用子任务目录。不持有执行状态，不依赖工作流胶囊显隐。
- 成功成员摘要标注“结果”，无摘要诚实显示“已完成，可查看过程”；成功成员显示“查看结果”并复用整行原生按钮打开只读详情，失败保留“原因”。
- 输入区只计算 manifest 已登记成员；协议 running[] 无 pending。未登记 pending 仍在主对话工作卡保持活动，不显示空目录、不造 child 或提前计数。
- 名称解析统一为任务名优先；运行卡可主动折叠，等待不使用运行 spinner，失败/停止只计为结束。
