# Skills Hub UI 契约

设置页「技能」用户范围顶部的外部技能同步面板（说明、新发现、立即同步、清理多余链接、冲突选择），以及技能来源标与来源筛选。状态来自 `useSkillsHub`（`packages/ui/src/hooks/skills-hub`），它只经 `ISkillsService` 的 Hub 方法读写；UI 不缓存第二份事实，每次命令返回或 `onDidChangeHub` 事件都整体替换状态。来源标按技能真实路径投影，Composer 与设置页共用。规则见 docs/skills-hub-spec.md。
