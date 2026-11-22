# reference-icons

引用图标与任务标题引用显示（规则见 [任务标题引用显示](../../../../docs/ui/task-title-reference-display.md)）。

- 图标：`REFERENCE_ICON_NODES`（skill / session / file / url / image，16×16 viewBox、1.5 线宽、currentColor）是唯一图标数据；`ReferenceIcon` 渲染 React SVG，`mentions/nodes/mentionIconDom` 以同一份数据生成 Lexical 原生 DOM 图标。
- `parseTaskTitleDisplay(title, { resolveSessionTitle?, fallbackLabels? })`：纯函数，把存储标题解析为 `{ kind, label }` 片段；不改存储标题、不读状态、无 IO。`getTaskTitleDisplayText` 拼接可读文本。
- `TaskTitleLookupProvider` / `useTaskTitleLookup`：任务列表用自身 props 提供只读 `taskId → title` 查找，是派生视图而不是第二份状态；缺省时引用会话显示 fallback 文案。
- `TaskTitleDisplay`：侧边栏标题渲染（图标 14px、`text-foreground-subtle`）；单行溢出仍由调用方的 `TaskTitleOverflowText` 负责。
