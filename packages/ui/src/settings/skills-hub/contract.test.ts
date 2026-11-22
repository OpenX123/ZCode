import { describe, expect, it } from "vitest";

import { exampleSkillSourceProjection } from "./contract.example.js";
import { filterSkillsBySource, resolveSkillSourceLabel } from "./contract.js";

const labels = { workspace: "工作区", plugin: "插件" };

describe("技能来源投影", () => {
  it("按真实路径筛选并给出来源标", () => {
    expect(exampleSkillSourceProjection()).toEqual(["Claude"]);
  });

  it("工作区技能显示工作区，YCode 插件显示插件名", () => {
    expect(
      resolveSkillSourceLabel({ path: "/w/.zcode/skills/a/SKILL.md", scope: "workspace" }, labels),
    ).toBe("工作区");
    expect(
      resolveSkillSourceLabel({ path: "/x/SKILL.md", scope: "plugin", pluginName: "docs" }, labels),
    ).toBe("docs");
    expect(resolveSkillSourceLabel({ path: "/x/SKILL.md", scope: "plugin" }, labels)).toBe("插件");
  });

  it("插件筛选同时包含 YCode 插件与 Claude 插件技能", () => {
    const skills = [
      { path: "/h/.claude/plugins/cache/m/sp/1/skills/a/SKILL.md", scope: "user" as const },
      { path: "/p/SKILL.md", scope: "plugin" as const, pluginName: "docs" },
      { path: "/h/.codex/skills/c/SKILL.md", scope: "user" as const },
    ];
    expect(filterSkillsBySource(skills, "plugin")).toHaveLength(2);
    expect(filterSkillsBySource(skills, "codex")).toHaveLength(1);
    expect(filterSkillsBySource(skills, "all")).toHaveLength(3);
  });
});
