# subagent-display

多智能体展示：头像（瓦片脸 + 类型轮廓）、胶囊头像串、对话行内 Subagent 工作卡（无子会话时为旧派发行 / Agent 卡）、右侧详情头部与只读提示。完整规则见 [多智能体展示规范](../../../../docs/desktop/multi-agent-display-spec.md)。

- 只读投影：父会话 `snapshot.subagents` / `backgroundWorks` / 时间线行，子会话 `control` / 行窗口。不保存运行态、不按引擎分支；W8 只读取协议新增的可选 `model` / `effort` / `toolCallCount`。
- 头像序号由 `buildSubagentAvatarIndex(childSessionIds)` 派生，未登记成员用 `resolveSubagentAvatarIndexes` 的临时序号；颜色从不表示状态。
- `groupConsecutiveAgentSpawns` 合并同一轮相邻派发：任一成员有子会话 → `workCard`（1 个也成组），否则 ≥2 个 → `sentence`；只用于实时对话时间线。
- `useSubagentWorkLiveIndex` 从父会话 `running[]` 与 `backgroundWorks` 派生 waiting / blocked 与可停 workId，内容不变时引用稳定；停止规则 `resolveSubagentStopWorkId` 与详情头部共用。
- 工作卡折叠态与派发行展开态只在 Renderer 内存；打开子会话复用 `onOpenSubagentSession`，停止与"停止全部"逐个复用父会话 `cancelBackgroundWork`（D7），不新增命令。
