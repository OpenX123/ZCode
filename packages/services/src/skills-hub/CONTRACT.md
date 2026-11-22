# Skills Hub 同步服务契约

`createSkillsHub` 是外部技能链接与清单（`<home>/.zcode/skills-hub.json`）的唯一写入者，运行在 Host 进程，经 `ISkillsService` 暴露给 UI。`sync` 扫描 YCode 技能根、Claude、Codex（不含 `.system`）、agents 与已安装 Claude 插件技能，按真实目录合并、按名称分组、按内容哈希去重，只为冲突胜出者建 junction（Windows）/ symlink 链接，目标为 realpath。

自动清理只处理清单中且仍指向清单目标的受管链接；被用户替换或改指向的条目只移出清单，不动文件。`prune` 只删除用户确认且经服务端重新计算仍为候选的链接条目，真实目录与文件永不删除。冲突选择经 `SkillsHubChoiceStore` 持久化（生产为 AppSettings）。所有写操作进程内串行，重复同步幂等。规则见 docs/skills-hub-spec.md。
