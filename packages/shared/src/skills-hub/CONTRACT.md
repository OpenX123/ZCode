# Skills Hub 领域契约

外部技能统一管理的纯逻辑：按真实路径识别来源（YCode / Claude / Claude 插件 / Codex / agents / YCode 插件），生成来源标文案与筛选；`planSkillsHub` 把扫描事实（成员、用户冲突选择、现有条目、受管链接）转换为同步计划：冲突视图、要新建与删除的受管链接、手动清理候选。`parseSkillsHubManifest` 逐字段校验外部清单，无法识别的条目丢弃即视为非受管，绝不据此删除文件。

本模块无 I/O。唯一写入者是 services 的 SkillsHub（Host 进程）；UI 只读状态。规则见 docs/skills-hub-spec.md。
