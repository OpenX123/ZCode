/**
 * Skills Hub UI 契约：来源标与来源筛选的纯投影（无服务调用）。
 * 规则见 docs/skills-hub-spec.md「UI」。
 */
import {
  classifySkillHubSource,
  formatSkillHubSourceLabel,
  matchesSkillHubSourceFilter,
  type SkillHubSource,
  type SkillHubSourceFilter,
  type SkillsHubState,
} from "@zcode/shared/skills-hub";

export type { SkillHubSourceFilter } from "@zcode/shared/skills-hub";

export interface SkillSourceCandidate {
  path: string;
  scope: "workspace" | "user" | "plugin";
  pluginName?: string;
}

export const SKILL_SOURCE_FILTERS: readonly SkillHubSourceFilter[] = [
  "all",
  "ycode",
  "claude",
  "codex",
  "agents",
  "plugin",
];

export function resolveSkillSource(skill: SkillSourceCandidate): SkillHubSource {
  return classifySkillHubSource(skill);
}

/**
 * 列表项来源标：工作区技能显示“工作区”，YCode 插件显示插件名，用户级技能按真实路径显示
 * YCode / Claude / Codex / Agents / Claude 插件名。
 */
export function resolveSkillSourceLabel(
  skill: SkillSourceCandidate,
  labels: { workspace: string; plugin: string },
): string {
  if (skill.scope === "workspace") return labels.workspace;
  return formatSkillHubSourceLabel(resolveSkillSource(skill), labels.plugin);
}

export function filterSkillsBySource<T extends SkillSourceCandidate>(
  skills: readonly T[],
  filter: SkillHubSourceFilter,
): T[] {
  if (filter === "all") return [...skills];
  return skills.filter((skill) => matchesSkillHubSourceFilter(resolveSkillSource(skill), filter));
}

/**
 * UI 访问 Skills Hub 的端口：结构上由 ISkillsService 的 Hub 方法满足。
 * UI 层不直接依赖 services 实现（architecture rule ui-implementation-import）。
 */
export interface SkillsHubServicePort {
  syncHub(): Promise<SkillsHubState>;
  pruneHubLinks(params: { entryNames: string[] }): Promise<SkillsHubState>;
  setHubConflictChoice(params: {
    nameKey: string;
    realDir: string | null;
  }): Promise<SkillsHubState>;
  dismissHubDiscoveries(): Promise<SkillsHubState>;
  onDidChangeHub?: (listener: (state: SkillsHubState) => void) => { dispose(): void };
}
