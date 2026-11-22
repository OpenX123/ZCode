import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSkillHubPath } from "@zcode/shared/skills-hub";
import { createSkillsHub, type ISkillsHub } from "../../src/skills-hub/index.js";

const execFileAsync = promisify(execFile);

// 所有用例只在 mkdtemp 临时目录内读写，通过注入 homeDir 隔离真实用户目录。
let home: string;
let choices: Record<string, string>;
let hub: ISkillsHub;

async function writeSkill(dir: string, name: string, body = "body"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
  return realpath(dir);
}

const ycodeRoot = () => join(home, ".zcode", "skills");
const linkType = process.platform === "win32" ? "junction" : "dir";

async function isLink(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isSymbolicLink() ?? false;
}

async function linkTarget(path: string): Promise<string> {
  return normalizeSkillHubPath(await realpath(path)).toLowerCase();
}

function same(path: string): string {
  return normalizeSkillHubPath(path).toLowerCase();
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "skills-hub-")));
  choices = {};
  hub = createSkillsHub({
    homeDir: () => home,
    isAvailable: () => true,
    choices: {
      read: async () => ({ ...choices }),
      write: async (next) => {
        choices = { ...next };
      },
    },
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("skills hub 同步", () => {
  it("链接 Claude、Claude 插件当前版本，跳过 Codex .system、插件旧版本与 agents", async () => {
    const claudeFoo = await writeSkill(join(home, ".claude", "skills", "foo"), "foo");
    await writeSkill(join(home, ".codex", "skills", ".system", "sys"), "sys");
    await writeSkill(join(home, ".agents", "skills", "bar"), "bar");
    const pluginRoot = join(home, ".claude", "plugins", "cache", "mk", "superp");
    const brain = await writeSkill(join(pluginRoot, "1.0.0", "skills", "brain"), "brain");
    await writeSkill(join(pluginRoot, "0.9.0", "skills", "old"), "old");
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "superp@mk": [{ scope: "user", installPath: join(pluginRoot, "1.0.0") }] },
      }),
    );

    const state = await hub.sync();

    expect(state.available).toBe(true);
    expect(state.createdCount).toBe(2);
    expect(await isLink(join(ycodeRoot(), "foo"))).toBe(true);
    expect(await linkTarget(join(ycodeRoot(), "foo"))).toBe(same(claudeFoo));
    expect(await linkTarget(join(ycodeRoot(), "brain"))).toBe(same(brain));
    for (const skipped of ["sys", "old", "bar"]) {
      expect(await isLink(join(ycodeRoot(), skipped))).toBe(false);
    }
    // 幂等：再次同步不产生变化。
    const again = await hub.sync();
    expect(again).toMatchObject({ createdCount: 0, removedCount: 0, managedLinkCount: 2 });
  });

  it("同名同内容只链接一次；已有指向同一真实目录的链接时不重复建链接", async () => {
    await writeSkill(join(home, ".claude", "skills", "foo"), "foo", "same");
    await writeSkill(join(home, ".codex", "skills", "foo"), "foo", "same");
    const claudeDup = await writeSkill(join(home, ".claude", "skills", "dup"), "dup");
    await mkdir(ycodeRoot(), { recursive: true });
    await symlink(claudeDup, join(ycodeRoot(), "legacy-dup"), linkType);

    const state = await hub.sync();

    expect(state.conflicts).toEqual([]);
    expect(state.createdCount).toBe(1);
    expect(await isLink(join(ycodeRoot(), "foo"))).toBe(true);
    expect(await isLink(join(ycodeRoot(), "dup"))).toBe(false);
  });

  it("内容不同为冲突：默认 Claude，改选 Codex 后链接改指且选择被持久化", async () => {
    const claudeFoo = await writeSkill(join(home, ".claude", "skills", "foo"), "foo", "a");
    const codexFoo = await writeSkill(join(home, ".codex", "skills", "foo"), "foo", "b");

    const first = await hub.sync();
    expect(first.conflicts).toHaveLength(1);
    expect(same(first.conflicts[0]!.chosenRealDir)).toBe(same(claudeFoo));
    expect(await linkTarget(join(ycodeRoot(), "foo"))).toBe(same(claudeFoo));

    const switched = await hub.setConflictChoice("foo", codexFoo);
    expect(switched.conflicts[0]?.userChosen).toBe(true);
    expect(await linkTarget(join(ycodeRoot(), "foo"))).toBe(same(codexFoo));
    expect(choices).toEqual({ foo: codexFoo });
    // 源目录都还在：切换只删链接，不动任何真实目录。
    expect((await stat(claudeFoo)).isDirectory()).toBe(true);

    await hub.setConflictChoice("foo", null);
    expect(await linkTarget(join(ycodeRoot(), "foo"))).toBe(same(claudeFoo));
  });

  it("源头消失时只删除受管链接，非受管条目与真实目录不受影响", async () => {
    const sourceDir = join(home, ".claude", "skills", "gone");
    await writeSkill(sourceDir, "gone");
    const own = await writeSkill(join(ycodeRoot(), "own"), "own");
    const agentsBar = await writeSkill(join(home, ".agents", "skills", "bar"), "bar");
    await symlink(agentsBar, join(ycodeRoot(), "legacy-bar"), linkType);
    await hub.sync();
    expect(await isLink(join(ycodeRoot(), "gone"))).toBe(true);

    await rm(sourceDir, { recursive: true, force: true });
    const state = await hub.sync();

    expect(state.removedCount).toBe(1);
    expect(await lstat(join(ycodeRoot(), "gone")).catch(() => null)).toBeNull();
    expect((await stat(own)).isDirectory()).toBe(true);
    expect(await isLink(join(ycodeRoot(), "legacy-bar"))).toBe(true);
  });

  it("用户把受管链接替换为真实目录后只移出清单，不删除目录", async () => {
    await writeSkill(join(home, ".claude", "skills", "foo"), "foo");
    await hub.sync();
    const linkPath = join(ycodeRoot(), "foo");
    await unlink(linkPath);
    await writeSkill(linkPath, "foo", "mine");

    const state = await hub.sync();

    expect(state.managedLinkCount).toBe(0);
    expect(await isLink(linkPath)).toBe(false);
    expect(await readFile(join(linkPath, "SKILL.md"), "utf-8")).toContain("mine");
  });

  it("手动清理只删除确认且仍为候选的链接，真实目录与链接目标保留", async () => {
    const agentsBar = await writeSkill(join(home, ".agents", "skills", "bar"), "bar");
    await writeSkill(join(ycodeRoot(), "own"), "own");
    await symlink(agentsBar, join(ycodeRoot(), "legacy-bar"), linkType);

    const before = await hub.sync();
    expect(before.pruneCandidates).toEqual([
      expect.objectContaining({ entryName: "legacy-bar", reason: "agents", managed: false }),
    ]);

    const after = await hub.prune(["legacy-bar", "own"]);

    expect(after.pruneCandidates).toEqual([]);
    expect(await lstat(join(ycodeRoot(), "legacy-bar")).catch(() => null)).toBeNull();
    expect((await stat(join(ycodeRoot(), "own"))).isDirectory()).toBe(true);
    expect((await stat(join(agentsBar, "SKILL.md"))).isFile()).toBe(true);
  });

  it("首次同步只建基线；之后新增的技能出现在新发现中，确认后清空", async () => {
    await writeSkill(join(home, ".claude", "skills", "a"), "a");
    expect((await hub.sync()).newSkills).toEqual([]);

    await writeSkill(join(home, ".codex", "skills", "b"), "b");
    const state = await hub.sync();
    expect(state.newSkills).toEqual([
      expect.objectContaining({ nameKey: "b", source: { kind: "codex" } }),
    ]);
    expect((await hub.dismissDiscoveries()).newSkills).toEqual([]);
    expect((await hub.sync()).newSkills).toEqual([]);
  });

  it("清单篡改的条目名不会被用来删除技能根之外的路径", async () => {
    const outside = await writeSkill(join(home, "outside"), "outside");
    await mkdir(join(home, ".zcode"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "skills-hub.json"),
      JSON.stringify({
        version: 1,
        links: { "../outside": { target: outside, nameKey: "x", source: "claude" } },
        pendingNewSkillKeys: [],
      }),
    );
    await hub.sync();
    expect((await stat(join(outside, "SKILL.md"))).isFile()).toBe(true);
  });

  it("Windows 使用 junction（无需管理员），其他平台使用目录 symlink", async () => {
    await writeSkill(join(home, ".claude", "skills", "foo"), "foo");
    await hub.sync();
    const linkPath = join(ycodeRoot(), "foo");
    expect((await readlink(linkPath)).length).toBeGreaterThan(0);
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath '${linkPath.replaceAll("'", "''")}').LinkType`,
      ]);
      expect(stdout.trim()).toBe("Junction");
    } else {
      expect(await isLink(linkPath)).toBe(true);
    }
  });

  it("只有 .ycode 时链接建在 .ycode/skills，不新建真实 .zcode 目录", async () => {
    await mkdir(join(home, ".ycode"), { recursive: true });
    await writeSkill(join(home, ".claude", "skills", "foo"), "foo");

    await hub.sync();

    expect(await isLink(join(home, ".ycode", "skills", "foo"))).toBe(true);
    expect(await lstat(join(home, ".zcode")).catch(() => null)).toBeNull();
  });
});
