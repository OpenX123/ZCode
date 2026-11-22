import { describe, expect, it } from "vitest";

import type { SkillHubSource } from "@zcode/shared/skills-hub";
import { planSkillsHub, type SkillsHubMember } from "@zcode/shared/skills-hub";

function member(
  overrides: Partial<SkillsHubMember> & { realDir: string; source: SkillHubSource },
): SkillsHubMember {
  const dirName = overrides.realDir.split("/").at(-1) ?? "skill";
  return {
    name: dirName,
    nameKey: dirName.toLowerCase(),
    contentHash: `hash:${overrides.realDir}`,
    directlyVisible: overrides.source.kind === "agents" || overrides.source.kind === "ycode",
    entries: [],
    preferredLinkName: dirName,
    ...overrides,
  };
}

const CLAUDE = { kind: "claude" } as const;
const CODEX = { kind: "codex" } as const;
const AGENTS = { kind: "agents" } as const;
const YCODE = { kind: "ycode" } as const;

describe("planSkillsHub 去重", () => {
  it("同名同内容只建一个链接，优先 Claude", () => {
    const plan = planSkillsHub({
      members: [
        member({ realDir: "/h/.claude/skills/foo", source: CLAUDE, contentHash: "same" }),
        member({ realDir: "/h/.codex/skills/foo", source: CODEX, contentHash: "same" }),
      ],
      choices: {},
      occupiedEntryNames: [],
      managedLinks: [],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.linksToCreate).toEqual([
      { name: "foo", target: "/h/.claude/skills/foo", nameKey: "foo", source: CLAUDE },
    ]);
  });

  it("agents 已直接可见时同内容的外部副本不建链接", () => {
    const plan = planSkillsHub({
      members: [
        member({ realDir: "/h/.claude/skills/foo", source: CLAUDE, contentHash: "same" }),
        member({ realDir: "/h/.agents/skills/foo", source: AGENTS, contentHash: "same" }),
      ],
      choices: {},
      occupiedEntryNames: [],
      managedLinks: [],
    });
    expect(plan.linksToCreate).toEqual([]);
  });

  it("已有非受管链接指向胜出者时不重复建链接", () => {
    const plan = planSkillsHub({
      members: [
        member({
          realDir: "/h/.claude/skills/foo",
          source: CLAUDE,
          entries: [{ name: "foo", isLink: true, managed: false }],
        }),
      ],
      choices: {},
      occupiedEntryNames: ["foo"],
      managedLinks: [],
    });
    expect(plan.linksToCreate).toEqual([]);
    expect(plan.pruneCandidates).toEqual([]);
  });
});

describe("planSkillsHub 冲突", () => {
  const members = [
    member({ realDir: "/h/.claude/skills/foo", source: CLAUDE, contentHash: "a" }),
    member({ realDir: "/h/.codex/skills/foo", source: CODEX, contentHash: "b" }),
  ];

  it("默认按优先级取 Claude，并报告冲突", () => {
    const plan = planSkillsHub({ members, choices: {}, occupiedEntryNames: [], managedLinks: [] });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      nameKey: "foo",
      chosenRealDir: "/h/.claude/skills/foo",
      defaultRealDir: "/h/.claude/skills/foo",
      userChosen: false,
    });
    expect(plan.linksToCreate.map((link) => link.target)).toEqual(["/h/.claude/skills/foo"]);
  });

  it("用户改选 Codex 后删除旧受管链接、改链 Codex", () => {
    const withManaged = [
      { ...members[0]!, entries: [{ name: "foo", isLink: true, managed: true }] },
      members[1]!,
    ];
    const plan = planSkillsHub({
      members: withManaged,
      choices: { foo: "/h/.codex/skills/foo" },
      occupiedEntryNames: ["foo"],
      managedLinks: [{ name: "foo", target: "/h/.claude/skills/foo" }],
    });
    expect(plan.managedLinksToRemove).toEqual(["foo"]);
    // 被删除的受管链接名可复用。
    expect(plan.linksToCreate).toEqual([
      { name: "foo", target: "/h/.codex/skills/foo", nameKey: "foo", source: CODEX },
    ]);
    expect(plan.conflicts[0]?.userChosen).toBe(true);
  });

  it("YCode 自有副本优先，外部冲突副本不建链接", () => {
    const plan = planSkillsHub({
      members: [
        member({
          realDir: "/h/.ycode/skills/foo",
          source: YCODE,
          contentHash: "own",
          entries: [{ name: "foo", isLink: false, managed: false }],
        }),
        member({ realDir: "/h/.claude/skills/foo", source: CLAUDE, contentHash: "a" }),
      ],
      choices: {},
      occupiedEntryNames: ["foo"],
      managedLinks: [],
    });
    expect(plan.linksToCreate).toEqual([]);
    expect(plan.conflicts[0]?.chosenRealDir).toBe("/h/.ycode/skills/foo");
  });

  it("名字被占用时使用来源后缀", () => {
    const plan = planSkillsHub({
      members: [member({ realDir: "/h/.codex/skills/foo", source: CODEX })],
      choices: {},
      occupiedEntryNames: ["foo"],
      managedLinks: [],
    });
    expect(plan.linksToCreate[0]?.name).toBe("foo-codex");
  });
});

describe("planSkillsHub 清理", () => {
  it("源头消失的受管链接被移除", () => {
    const plan = planSkillsHub({
      members: [],
      choices: {},
      occupiedEntryNames: ["gone"],
      managedLinks: [{ name: "gone", target: "/h/.claude/skills/gone" }],
    });
    expect(plan.managedLinksToRemove).toEqual(["gone"]);
  });

  it("手动清理候选只包含非受管链接：agents 链接、重复链接与冲突落败链接", () => {
    const plan = planSkillsHub({
      members: [
        member({
          realDir: "/h/.agents/skills/bar",
          source: AGENTS,
          entries: [{ name: "bar", isLink: true, managed: false }],
        }),
        member({
          realDir: "/h/.claude/skills/dup",
          source: CLAUDE,
          entries: [
            { name: "dup", isLink: true, managed: false },
            { name: "dup-copy", isLink: true, managed: false },
          ],
        }),
        member({ realDir: "/h/.claude/skills/foo", source: CLAUDE, contentHash: "a" }),
        member({
          realDir: "/h/.codex/skills/foo",
          source: CODEX,
          contentHash: "b",
          entries: [{ name: "foo", isLink: true, managed: false }],
        }),
        member({
          realDir: "/h/.ycode/skills/real",
          source: YCODE,
          entries: [{ name: "real", isLink: false, managed: false }],
        }),
      ],
      choices: {},
      occupiedEntryNames: ["bar", "dup", "dup-copy", "foo", "real"],
      managedLinks: [],
    });
    expect(plan.pruneCandidates).toEqual([
      { entryName: "bar", target: "/h/.agents/skills/bar", reason: "agents", managed: false },
      {
        entryName: "dup-copy",
        target: "/h/.claude/skills/dup",
        reason: "duplicate",
        managed: false,
      },
      { entryName: "foo", target: "/h/.codex/skills/foo", reason: "conflictLoser", managed: false },
    ]);
    // 落败链接占用了名字，胜出者用后缀名链接。
    expect(plan.linksToCreate).toEqual([
      { name: "foo-claude", target: "/h/.claude/skills/foo", nameKey: "foo", source: CLAUDE },
    ]);
  });

  it("Windows 路径比较忽略大小写", () => {
    const plan = planSkillsHub({
      members: [
        member({
          realDir: "C:/Users/Me/.claude/skills/foo",
          source: CLAUDE,
          entries: [{ name: "foo", isLink: true, managed: true }],
        }),
      ],
      choices: {},
      occupiedEntryNames: ["foo"],
      managedLinks: [{ name: "foo", target: "c:/users/me/.claude/skills/foo" }],
      caseInsensitive: true,
    });
    expect(plan.managedLinksToRemove).toEqual([]);
    expect(plan.linksToCreate).toEqual([]);
  });
});
