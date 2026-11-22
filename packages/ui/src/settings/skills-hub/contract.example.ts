/**
 * skills-hub-ui 标准调用示例：按来源筛选技能并取来源标。
 */
import { filterSkillsBySource, resolveSkillSourceLabel } from "./contract.js";

export function exampleSkillSourceProjection() {
  const skills = [
    { path: "/home/me/.claude/skills/a/SKILL.md", scope: "user" as const },
    { path: "/home/me/.zcode/skills/b/SKILL.md", scope: "user" as const },
  ];
  return filterSkillsBySource(skills, "claude").map((skill) =>
    resolveSkillSourceLabel(skill, { workspace: "Workspace", plugin: "Plugin" }),
  );
}
