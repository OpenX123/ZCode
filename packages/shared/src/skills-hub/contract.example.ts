/**
 * skills-hub 标准调用示例：按真实路径给技能打来源标。
 */
import { classifySkillHubSource, formatSkillHubSourceLabel } from "./contract.js";

export function exampleSkillSourceLabel(): string {
  return formatSkillHubSourceLabel(
    classifySkillHubSource({
      path: "C:\\Users\\me\\.claude\\skills\\demo\\SKILL.md",
      scope: "user",
    }),
  );
}
