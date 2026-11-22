/**
 * Skills Hub 来源扫描：把 YCode 技能根、Claude / Codex / agents 与已安装 Claude 插件技能
 * 收敛成按真实目录合并的成员列表。只读，不写任何文件。
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  classifySkillHubSource,
  normalizeSkillHubNameKey,
  normalizeSkillHubPath,
  type SkillHubSource,
  type SkillsHubIssue,
  type SkillsHubMember,
} from "@zcode/shared/skills-hub";
import { walkSkillMarkdownPaths } from "../skills/skillDiscoveryWalk.js";
import { readSkillMetadataFromMarkdown } from "../settings-sync/settingsSyncService.js";

export interface SkillsHubPaths {
  ycodeRoot: string;
  claudeRoot: string;
  codexRoot: string;
  agentsRoot: string;
  claudePluginsRoot: string;
  installedPluginsFile: string;
  claudeSettingsFile: string;
}

export async function resolveSkillsHubPaths(home: string): Promise<SkillsHubPaths> {
  // 与 skillsService / CLI 一致优先使用 `.zcode`（迁移后它是指向 `.ycode` 的链接）；
  // 只有 `.zcode` 不存在而 `.ycode` 存在时改用 `.ycode`，避免同步时新建一个真实 `.zcode`
  // 目录、与数据根迁移的链接布局冲突（docs/desktop/ycode-data-dir-migration.md）。
  const hasLegacy = await lstat(join(home, ".zcode")).then(
    () => true,
    () => false,
  );
  const hasNext =
    !hasLegacy &&
    (await lstat(join(home, ".ycode")).then(
      () => true,
      () => false,
    ));
  return {
    ycodeRoot: join(home, hasNext ? ".ycode" : ".zcode", "skills"),
    claudeRoot: join(home, ".claude", "skills"),
    codexRoot: join(home, ".codex", "skills"),
    agentsRoot: join(home, ".agents", "skills"),
    claudePluginsRoot: join(home, ".claude", "plugins"),
    installedPluginsFile: join(home, ".claude", "plugins", "installed_plugins.json"),
    claudeSettingsFile: join(home, ".claude", "settings.json"),
  };
}

type HitOrigin = "ycode" | "claude" | "codex" | "agents" | "claudePlugin";

interface RawHit {
  skillFile: string;
  origin: HitOrigin;
  pluginName?: string;
  entry?: { name: string; isLink: boolean };
}

export interface SkillsHubScanResult {
  /** realDir 为原生 realpath 字符串（建链接与比较时再规范化）。 */
  members: SkillsHubMember[];
  occupiedEntryNames: string[];
  issues: SkillsHubIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

async function collectWalk(rootPath: string): Promise<string[]> {
  const found: string[] = [];
  for await (const skillFile of walkSkillMarkdownPaths(rootPath)) found.push(skillFile);
  return found;
}

/** installed_plugins.json 兼容 v1（对象）与 v2（数组）；只取用户级安装的当前版本。 */
export async function readInstalledClaudePlugins(
  paths: SkillsHubPaths,
): Promise<Array<{ pluginName: string; installPath: string }>> {
  const installed = await readJson(paths.installedPluginsFile);
  if (!isRecord(installed) || !isRecord(installed.plugins)) return [];
  const settings = await readJson(paths.claudeSettingsFile);
  const enabledPlugins =
    isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const result: Array<{ pluginName: string; installPath: string }> = [];
  for (const [pluginId, raw] of Object.entries(installed.plugins)) {
    if (enabledPlugins[pluginId] === false) continue;
    const records = Array.isArray(raw) ? raw : [raw];
    for (const record of records) {
      if (!isRecord(record) || typeof record.installPath !== "string") continue;
      // 项目级安装不处理（决策 1：项目级 .claude/skills 不做）。
      if (record.scope !== undefined && record.scope !== "user") continue;
      result.push({
        pluginName: pluginId.split("@")[0] || pluginId,
        installPath: record.installPath,
      });
    }
  }
  return result;
}

function isInside(child: string, parent: string, caseInsensitive: boolean): boolean {
  const normalize = (value: string) => {
    const normalized = normalizeSkillHubPath(value);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const childKey = normalize(child);
  const parentKey = normalize(parent);
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

async function collectYcodeHits(ycodeRoot: string, occupied: string[]): Promise<RawHit[]> {
  let entries;
  try {
    entries = await readdir(ycodeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: RawHit[] = [];
  for (const entry of entries) {
    occupied.push(entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = join(ycodeRoot, entry.name);
    const isLink = (await lstat(entryPath).catch(() => null))?.isSymbolicLink() ?? false;
    // 每个顶层条目单独遍历：共享遍历会对软链目标去重，多个链接指向同一目录时
    // 后面的链接会被吞掉，无法识别“重复链接”。
    for (const skillFile of await collectWalk(entryPath)) {
      hits.push({ skillFile, origin: "ycode", entry: { name: entry.name, isLink } });
    }
  }
  return hits;
}

async function collectExternalHits(
  paths: SkillsHubPaths,
  caseInsensitive: boolean,
): Promise<RawHit[]> {
  const hits: RawHit[] = [];
  for (const skillFile of await collectWalk(paths.claudeRoot)) {
    hits.push({ skillFile, origin: "claude" });
  }
  for (const skillFile of await collectWalk(paths.codexRoot)) {
    // Codex 自带的 `.system` 技能不导入（决策 1）。
    if (relative(paths.codexRoot, skillFile).split(sep).includes(".system")) continue;
    hits.push({ skillFile, origin: "codex" });
  }
  for (const skillFile of await collectWalk(paths.agentsRoot)) {
    hits.push({ skillFile, origin: "agents" });
  }
  for (const plugin of await readInstalledClaudePlugins(paths)) {
    const pluginRoot = await realpath(plugin.installPath).catch(() => null);
    if (!pluginRoot) continue;
    for (const skillFile of await collectWalk(join(plugin.installPath, "skills"))) {
      const realSkillDir = await realpath(dirname(skillFile)).catch(() => null);
      // 插件内容不可信：技能真实目录必须仍在插件安装目录内，拒绝链接逃逸。
      if (!realSkillDir || !isInside(realSkillDir, pluginRoot, caseInsensitive)) continue;
      hits.push({ skillFile, origin: "claudePlugin", pluginName: plugin.pluginName });
    }
  }
  return hits;
}

async function resolveRealRoots(paths: SkillsHubPaths) {
  const resolveOrSelf = (path: string) => realpath(path).catch(() => path);
  return {
    claude: await resolveOrSelf(paths.claudeRoot),
    codex: await resolveOrSelf(paths.codexRoot),
    agents: await resolveOrSelf(paths.agentsRoot),
    claudePlugins: await resolveOrSelf(paths.claudePluginsRoot),
  };
}

export async function scanSkillsHubSources(params: {
  paths: SkillsHubPaths;
  managedEntryNames: ReadonlySet<string>;
  caseInsensitive: boolean;
}): Promise<SkillsHubScanResult> {
  const { paths, caseInsensitive } = params;
  const occupied: string[] = [];
  const issues: SkillsHubIssue[] = [];
  const hits = [
    ...(await collectYcodeHits(paths.ycodeRoot, occupied)),
    ...(await collectExternalHits(paths, caseInsensitive)),
  ];
  const realRoots = await resolveRealRoots(paths);
  const classify = (realDir: string, hit: RawHit): SkillHubSource => {
    if (hit.origin === "claudePlugin") return { kind: "claudePlugin", pluginName: hit.pluginName };
    if (isInside(realDir, realRoots.claude, caseInsensitive)) return { kind: "claude" };
    if (isInside(realDir, realRoots.codex, caseInsensitive)) return { kind: "codex" };
    if (isInside(realDir, realRoots.agents, caseInsensitive)) return { kind: "agents" };
    if (isInside(realDir, realRoots.claudePlugins, caseInsensitive)) {
      return classifySkillHubSource({ path: `${normalizeSkillHubPath(realDir)}/` });
    }
    return { kind: "ycode" };
  };

  const membersByKey = new Map<string, SkillsHubMember>();
  for (const hit of hits) {
    const realDir = await realpath(dirname(hit.skillFile)).catch(() => null);
    if (!realDir) {
      issues.push({ code: "scan_failed", message: "realpath failed", path: hit.skillFile });
      continue;
    }
    const memberKey = caseInsensitive
      ? normalizeSkillHubPath(realDir).toLowerCase()
      : normalizeSkillHubPath(realDir);
    let member = membersByKey.get(memberKey);
    if (!member) {
      let content: string;
      try {
        content = await readFile(join(realDir, "SKILL.md"), "utf-8");
      } catch (error) {
        issues.push({
          code: "scan_failed",
          message: error instanceof Error ? error.message : String(error),
          path: hit.skillFile,
        });
        continue;
      }
      const fallbackName = basename(realDir);
      const { name } = readSkillMetadataFromMarkdown(content, fallbackName);
      member = {
        realDir,
        name,
        nameKey: normalizeSkillHubNameKey(name),
        // 换行统一为 LF 再哈希：同一技能在不同平台检出后 CRLF/LF 不同不应算作冲突。
        contentHash: createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex"),
        source: classify(realDir, hit),
        directlyVisible: false,
        entries: [],
        preferredLinkName: fallbackName,
      };
      membersByKey.set(memberKey, member);
    } else if (hit.origin === "claudePlugin" && member.source.kind !== "claudePlugin") {
      member.source = classify(realDir, hit);
    }
    if (hit.origin === "agents") member.directlyVisible = true;
    if (hit.entry) {
      if (!hit.entry.isLink) member.directlyVisible = true;
      if (!member.entries.some((entry) => entry.name === hit.entry?.name)) {
        member.entries.push({
          name: hit.entry.name,
          isLink: hit.entry.isLink,
          managed: hit.entry.isLink && params.managedEntryNames.has(hit.entry.name),
        });
      }
    }
  }
  return { members: [...membersByKey.values()], occupiedEntryNames: occupied, issues };
}
