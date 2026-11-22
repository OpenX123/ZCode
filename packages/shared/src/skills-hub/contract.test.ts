import { describe, expect, it } from "vitest";

import {
  classifySkillHubSource,
  formatSkillHubSourceLabel,
  matchesSkillHubSourceFilter,
  parseSkillsHubManifest,
} from "./contract.js";

describe("skills hub 来源分类", () => {
  it.each([
    ["C:\\Users\\me\\.claude\\skills\\a\\SKILL.md", "claude", "Claude"],
    ["/home/me/.codex/skills/a/SKILL.md", "codex", "Codex"],
    ["/home/me/.agents/skills/a/SKILL.md", "agents", "Agents"],
    ["/home/me/.ycode/skills/a/SKILL.md", "ycode", "YCode"],
    ["/home/me/.zcode/skills/a/SKILL.md", "ycode", "YCode"],
    [
      "C:/Users/me/.claude/plugins/cache/official/superpowers/4.0.3/skills/brainstorming/SKILL.md",
      "claudePlugin",
      "superpowers",
    ],
  ])("%s → %s", (path, kind, label) => {
    const source = classifySkillHubSource({ path, scope: "user" });
    expect(source.kind).toBe(kind);
    expect(formatSkillHubSourceLabel(source)).toBe(label);
  });

  it("YCode 插件技能按 scope 显示插件名", () => {
    const source = classifySkillHubSource({
      path: "/home/me/.zcode/cli/plugins/cache/x/SKILL.md",
      scope: "plugin",
      pluginName: "docs",
    });
    expect(formatSkillHubSourceLabel(source)).toBe("docs");
    expect(matchesSkillHubSourceFilter(source, "plugin")).toBe(true);
    expect(matchesSkillHubSourceFilter(source, "claude")).toBe(false);
  });
});

describe("skills hub 清单解析", () => {
  it("丢弃不安全条目名与无法识别的字段", () => {
    const manifest = parseSkillsHubManifest({
      version: 1,
      links: {
        ok: { target: "/a", nameKey: "ok", source: "claude", createdAt: 1 },
        "../escape": { target: "/b", nameKey: "x", source: "claude" },
        bad: { target: "/c", nameKey: "x", source: "unknown" },
      },
      pendingNewSkillKeys: ["a", 1],
    });
    expect(Object.keys(manifest.links)).toEqual(["ok"]);
    expect(manifest.pendingNewSkillKeys).toEqual(["a"]);
    expect(manifest.seenSkillKeys).toBeUndefined();
  });

  it("版本不符时返回空清单", () => {
    expect(parseSkillsHubManifest({ version: 2, links: { a: {} } }).links).toEqual({});
  });
});
