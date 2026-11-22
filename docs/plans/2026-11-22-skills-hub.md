# 外部技能统一管理（Claude Code / Codex 技能导入、去重、启停）

来源：2026-11-22 与用户 grilling（Q30–Q40），全部按推荐确认。

## 现状（调查结论）
- 已有导入：`packages/services/src/settings-sync/settingsSyncService.ts` 从 `~/.claude/skills`、`~/.codex/skills` 等手动导入到 `~/.zcode/skills`（实际 `~/.ycode/skills`），默认 junction（Windows）/dir symlink；链接目标为 `resolve(sourcePath)`（会出现链接套链接）；去重仅按源路径字符串与目标同名；不支持 Claude 插件技能（插件导入只看 `~/.claude/plugins` 一层，真实插件在 `cache/<market>/<plugin>/<ver>`）。
- 桌面发现：`packages/services/src/skills/skillsService.ts`，按 realpath 去重；启停存 `~/.zcode/cli/config.json` `skills["<abs SKILL.md realpath>"] = { enable:false }`。
- CLI 发现：`apps/zcode-cli/packages/adapters/src/skills/{roots,scan,index}.ts`，只按扫描路径去重（无 realpath）→ 经链接导入的技能在 CLI 目录里出现两次（bug）。
- Composer：`$` 与 `/` 列技能（`MentionPlugin.tsx`、`SlashCommandPlugin.tsx`），`@` 列子代理等；目录来自 CLI `skill-reference-catalog`。
- 外部引擎（Claude/Codex ACP）不接收 YCode 技能；`/` 显示引擎自身 `available_commands_update`。
- 本机：claude 104、codex 31(+.system 6)、agents 122、ycode 64（全部 junction）；103 个名字跨源重复；Claude 已安装插件技能 22 个（frontend-design、superpowers 15、ponytail 6）。

## 决策
1. 来源：`~/.claude/skills`、`~/.codex/skills`（不含 `.system`）、`~/.agents/skills`（YCode 已直接读取，仅参与去重）、已安装 Claude 插件技能（读 `~/.claude/plugins/installed_plugins.json` 或等价清单，只取已安装版本，跳过 marketplace 缓存与旧版本）。项目级 `.claude/skills` 不做。
2. 方式：沿用软链，升级为自动同步：在 `~/.ycode/skills/<name>` 建 junction/symlink 指向**真实路径**（realpath，不链接套链接）；源头消失的、由本功能创建的失效链接自动清理（只删链接，绝不删目标/真实目录；非本功能创建的条目不动——用清单文件记录本功能管理的链接）。
3. 去重：按技能名（frontmatter `name`，缺省目录名，小写）分组；组内 realpath 相同或 `SKILL.md` 内容哈希相同 → 合并为一项；内容不同 → 冲突，默认按 YCode 自有 > Claude（含插件）> Codex > agents 取用，设置中可改选；冲突只为胜出者建链接。
4. 默认启用新发现技能；设置页顶部“新发现 N 个技能”。
5. 调用：`/` 与 `@` 都能调出技能（`@` 中单独“技能”分组），列表项带来源小标（YCode / Claude / Codex / 插件名）；`/` 中技能排在命令前。`$` 保持。
6. 设置：扩展现有“技能”页（`packages/ui/src/settings/SkillsSection.tsx`）：来源标记与来源筛选、冲突区块（选择采用哪份）、“立即同步”、“清理 N 个多余链接”（指向 YCode 已直接读取的 `~/.agents/skills` 的链接，以及重复链接；点按才清理，只删链接）。
7. 同步时机：应用启动、打开技能设置页、手动“立即同步”；不做文件监听。同步在 services 层异步执行，结果事件通知 UI；幂等。
8. 开关只作用于 YCode 原生引擎；设置页说明 Claude/Codex 会话使用各自技能。
9. 修复：CLI 技能发现按 realpath 去重（`adapters/src/skills/index.ts`），并与桌面一致地跟随链接。

## 状态所有者
- 同步与链接清单：services（main/host 进程）唯一写入；UI 只读并发起命令。
- 启停：沿用 `cli/config.json` `skills` overrides（realpath 键）。
- 冲突选择：持久化到 YCode 设置（AppSettings 或 cli/config.json 新字段，择一，写入 spec）。

## 验收
- 新装到 `~/.claude/skills` 的技能，重启或点“立即同步”后在 `/`、`@`、`$` 中可见，带来源标。
- 同名同内容只出现一次；同名不同内容在冲突区可切换，切换后链接指向所选。
- 关闭某技能后原生引擎会话不可调用；Claude 会话不受影响。
- 删除源技能后同步清理对应链接；绝不删除非本功能创建的条目与任何真实目录。
- CLI 技能目录不再重复列出经链接导入的技能。
- Windows（junction，无需管理员）、macOS/Linux（symlink）均可。
