/**
 * 外部技能统一管理（Skills Hub）文案，独立命名空间 settings.skills.hub.*。
 * 规则见 docs/skills-hub-spec.md。
 */
const P = "settings.skills.hub";

export const skillsHubZhCN: Record<string, string> = {
  [`${P}.title`]: "外部技能同步",
  [`${P}.description`]:
    "自动链接 Claude Code、Codex 与已安装 Claude 插件中的技能，同名同内容只保留一份。",
  [`${P}.engineNote`]:
    "这里的开关只作用于 YCode 原生引擎；Claude / Codex 会话使用各自的技能，不受影响。",
  [`${P}.syncNow`]: "立即同步",
  [`${P}.syncing`]: "同步中…",
  [`${P}.syncedSummary`]: "已链接 {count} 个外部技能",
  [`${P}.syncChanged`]: "本次新增 {created} 个链接，移除 {removed} 个",
  [`${P}.prune`]: "清理 {count} 个多余链接",
  [`${P}.prune.confirmTitle`]: "清理多余链接？",
  [`${P}.prune.confirmDescription`]:
    "只删除 YCode 技能目录中的链接本身，不会删除任何技能文件或真实目录：\n{list}",
  [`${P}.prune.confirm`]: "清理",
  [`${P}.prune.more`]: "等 {count} 个",
  [`${P}.prune.reason.agents`]: "YCode 已直接读取 ~/.agents/skills",
  [`${P}.prune.reason.duplicate`]: "重复链接",
  [`${P}.prune.reason.conflictLoser`]: "冲突中未采用的副本",
  [`${P}.newSkills`]: "新发现 {count} 个技能",
  [`${P}.newSkills.dismiss`]: "知道了",
  [`${P}.conflicts.title`]: "同名技能冲突（{count}）",
  [`${P}.conflicts.description`]: "同名但内容不同，选择 YCode 采用哪一份；只为采用的一份建立链接。",
  [`${P}.conflicts.use`]: "采用",
  [`${P}.conflicts.inUse`]: "已采用",
  [`${P}.conflicts.default`]: "默认",
  [`${P}.conflicts.reset`]: "恢复默认",
  [`${P}.issues`]: "{count} 个技能同步失败，详见日志",
  [`${P}.error`]: "外部技能同步失败：{message}",
  [`${P}.filter.label`]: "来源",
  [`${P}.filter.all`]: "全部",
  [`${P}.filter.ycode`]: "YCode",
  [`${P}.filter.claude`]: "Claude",
  [`${P}.filter.codex`]: "Codex",
  [`${P}.filter.agents`]: "Agents",
  [`${P}.filter.plugin`]: "插件",
  [`${P}.source.plugin`]: "插件",
  [`${P}.source.workspace`]: "工作区",
};

export const skillsHubEnUS: Record<string, string> = {
  [`${P}.title`]: "External skill sync",
  [`${P}.description`]:
    "Links skills from Claude Code, Codex and installed Claude plugins. Identical skills appear once.",
  [`${P}.engineNote`]:
    "Toggles here only affect the YCode engine. Claude / Codex sessions use their own skills.",
  [`${P}.syncNow`]: "Sync now",
  [`${P}.syncing`]: "Syncing…",
  [`${P}.syncedSummary`]: "{count} external skills linked",
  [`${P}.syncChanged`]: "{created} links added, {removed} removed in the last sync",
  [`${P}.prune`]: "Clean up {count} redundant links",
  [`${P}.prune.confirmTitle`]: "Clean up redundant links?",
  [`${P}.prune.confirmDescription`]:
    "Only the links inside the YCode skills folder are removed. No skill files or real folders are deleted:\n{list}",
  [`${P}.prune.confirm`]: "Clean up",
  [`${P}.prune.more`]: "and {count} more",
  [`${P}.prune.reason.agents`]: "YCode already reads ~/.agents/skills",
  [`${P}.prune.reason.duplicate`]: "Duplicate link",
  [`${P}.prune.reason.conflictLoser`]: "Unused copy in a conflict",
  [`${P}.newSkills`]: "{count} new skills found",
  [`${P}.newSkills.dismiss`]: "Got it",
  [`${P}.conflicts.title`]: "Skill name conflicts ({count})",
  [`${P}.conflicts.description`]:
    "Same name, different content. Choose which copy YCode uses; only that copy is linked.",
  [`${P}.conflicts.use`]: "Use",
  [`${P}.conflicts.inUse`]: "In use",
  [`${P}.conflicts.default`]: "Default",
  [`${P}.conflicts.reset`]: "Reset to default",
  [`${P}.issues`]: "{count} skills failed to sync. See logs for details.",
  [`${P}.error`]: "External skill sync failed: {message}",
  [`${P}.filter.label`]: "Source",
  [`${P}.filter.all`]: "All",
  [`${P}.filter.ycode`]: "YCode",
  [`${P}.filter.claude`]: "Claude",
  [`${P}.filter.codex`]: "Codex",
  [`${P}.filter.agents`]: "Agents",
  [`${P}.filter.plugin`]: "Plugins",
  [`${P}.source.plugin`]: "Plugin",
  [`${P}.source.workspace`]: "Workspace",
};
