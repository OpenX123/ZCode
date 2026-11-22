import { useMemo } from "react";
import type { Locale, SkillScope, ZCodeProvider } from "@zcode/shared";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { useSkills } from "@/hooks/useSkills.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSkillDisplayDescription, resolveSkillSourceLabel } from "@/lib/builtinSkillI18n.js";
import { resolveSkillSourceLabel as resolveSkillHubSourceLabel } from "@/settings/skills-hub/index.js";

export function mapSkillsToMentionItemsForTest(
  skills: Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    scope: SkillScope;
    pluginName?: string;
  }>,
  locale?: Locale,
): MentionItem[] {
  const uniqueSkillsByName = new Map<string, (typeof skills)[number]>();
  const scopePriority: Record<SkillScope, number> = {
    workspace: 0,
    plugin: 1,
    user: 2,
  };
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    const current = uniqueSkillsByName.get(key);
    // `$` 面板是执行入口，不是来源管理页。
    // 同名技能如果来自 workspace/user/plugin 多个路径，继续全部展示会让用户看到“同一个 skill”重复刷屏。
    // 这里按名称折叠，并优先选择 workspace，其次 plugin，最后 user；Settings 页仍保留完整来源列表用于管理。
    if (!current || scopePriority[skill.scope] < scopePriority[current.scope]) {
      uniqueSkillsByName.set(key, skill);
    }
  }
  const uniqueSkills = [...uniqueSkillsByName.values()];

  return uniqueSkills.map((skill) => {
    // 来源小标（docs/skills-hub-spec.md「UI」）：工作区显示“工作区”，YCode 插件显示插件名，
    // 用户级技能按真实路径显示 YCode / Claude / Codex / Agents / Claude 插件名。
    const sourceLabel = resolveSkillHubSourceLabel(skill, {
      workspace: resolveSkillSourceLabel("workspace", locale),
      plugin: resolveSkillSourceLabel("plugin", locale),
    });
    const description = resolveSkillDisplayDescription(skill, locale);
    return {
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      description,
      badge: sourceLabel,
      value: skill.name,
      markdown: buildSkillMentionMarkdown(skill.name, skill.path),
      keywords: [
        ...new Set([skill.name, skill.description, description, skill.scope, sourceLabel]),
      ],
      data: {
        path: skill.path,
        scope: skill.scope,
      },
    };
  });
}

export function useSkillsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  provider: ZCodeProvider,
  query: string,
  enabled: boolean,
  requireQuery: boolean,
  emptyText: string,
  title: string,
  /** `@` 面板无查询时只预览少量技能，避免技能分组淹没文件分组；`$` 不限制。 */
  limit?: number,
): MentionCategoryResult {
  const { locale } = useZCodeIntl();
  const { skills, loading, error } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId,
    enabled,
  });

  const allItems = useMemo(
    () =>
      mapSkillsToMentionItemsForTest(
        filterSkillsForProvider(skills, provider).filter((skill) => skill.enabled),
        locale,
      ),
    [locale, provider, skills],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery,
        ...(limit !== undefined ? { limit } : {}),
      }),
    [allItems, limit, query, requireQuery],
  );

  return {
    items: enabled ? items : [],
    loading,
    error: error ? new Error(error) : null,
    emptyText,
    title,
  };
}
