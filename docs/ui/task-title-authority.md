# Task Title Authority

Task title can come from several places during a session lifecycle. Renderer code must treat them as ordered candidates instead of letting the newest snapshot string always win.

## Title priority

1. User-renamed title with `titleOverridden=true`.
2. Agent-generated title from the session/title update pipeline.
3. First user query title used as the initial optimistic title.
4. The agent default placeholder `New session`.

## 技能引用的初始标题

- CLI 从首条输入派生标题时，先将 `[$skill](path)` 技能链接转换为 `$skill`，再合并空白并按现有长度上限截断。多个技能和后续需求文字保留；仅引用技能时使用技能名称。
- 只处理 Markdown 解析器识别到的技能链接，行内代码、普通链接和不完整链接保持原文。消息正文、发给模型的技能路径、模型生成标题和用户手动标题不受影响。
- 派生结果仍由 CLI 落盘为 `first_input`，并通过既有标题事件同步到 Host；顶部和侧栏读取同一事实，不分别修补显示。已落盘的历史标题不在此变更中迁移。
- 验收覆盖 macOS、Windows、带空格或括号的技能路径、多个技能、仅技能、清理后截断，以及内置与外部引擎的落盘标题、标题事件及原始正文一致性。

## Renderer restore rule

- CLI owns persisted titles and title source; `tasks-index.sqlite` contains their read-only Host projection.
- The active header reads the existing workspace-scoped `ZCodeTaskService.getTaskMeta` and refreshes on Host metadata events. It does not depend on a sidebar/query-cache row or call `readSession` to obtain a title. Historical and archived sessions can have metadata before their CLI runtime is active.
- `readSession` / `resumeSession` returns a raw agent snapshot. Its projected task meta is only a runtime candidate and can be missing app-side `titleOverridden`.
- Restore and remaining task cache sync paths must merge raw snapshot meta with indexed/query-cache meta before writing renderer caches. The active header uses Host metadata directly; existing optimistic metadata is used only before the indexed record arrives.
- A raw snapshot title must not overwrite a title whose existing meta has `titleOverridden=true`.
- `New session` must not overwrite a non-placeholder title, even when the snapshot has a newer `updatedAt`.
- Generated titles may replace the first query title when there is no user override.

## Compatibility

- Workspace-scoped title lookup uses `workspaceIdentity?.trim() || workspacePath`, matching remote workspace isolation. The active read also belongs to its scoped service/attachment and task ID; late responses cannot overwrite a newer target or request.
- The rule applies to desktop `desktop-continuous` restore and web remote `web-remote-replayable` restore. Replayable recovery can use snapshots to refill runtime fields, but it must not bypass the same title authority merge.
