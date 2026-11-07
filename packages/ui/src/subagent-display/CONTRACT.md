# subagent-display

多智能体展示：头像（瓦片脸 + 类型轮廓）、胶囊头像串、对话行内派发行、Agent 卡头像、右侧详情头部。完整规则见 [多智能体展示规范](../../../../docs/desktop/multi-agent-display-spec.md)。

- 只读投影：父会话 `snapshot.subagents` / `backgroundWorks` / 时间线行，子会话 `control` / 行窗口。不保存运行态、不新增协议，也不按引擎分支。
- 头像序号由 `buildSubagentAvatarIndex(childSessionIds)` 派生，未登记成员用 `resolveSubagentAvatarIndexes` 的临时序号；颜色从不表示状态。
- `groupConsecutiveAgentSpawns` 只合并同一轮相邻 ≥2 个派发，只用于实时对话时间线。
- 派发行的展开态只在 Renderer 内存；打开子会话复用 `onOpenSubagentSession`，停止复用父会话 `cancelBackgroundWork`。
