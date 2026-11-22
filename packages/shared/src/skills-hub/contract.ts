/**
 * Skills Hub 纯契约：来源分类、状态视图与清单格式。无 I/O。
 * 规则来源：docs/skills-hub-spec.md。
 */

export type SkillHubSourceKind =
  | "ycode"
  | "claude"
  | "claudePlugin"
  | "codex"
  | "agents"
  | "plugin";

export interface SkillHubSource {
  kind: SkillHubSourceKind;
  /** claudePlugin / plugin 时为插件名。 */
  pluginName?: string;
}

/** 冲突默认取用顺序：YCode 自有 > Claude（含插件）> Codex > agents。数字越小越优先。 */
export const SKILL_HUB_SOURCE_PRIORITY: Readonly<Record<SkillHubSourceKind, number>> = {
  ycode: 0,
  plugin: 0,
  claude: 1,
  claudePlugin: 1,
  codex: 2,
  agents: 3,
};

/** 规范化路径：统一正斜杠、去掉末尾斜杠。比较前再按平台决定是否忽略大小写。 */
export function normalizeSkillHubPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/u, "") : slashed;
}

export function normalizeSkillHubNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 按真实路径识别技能来源。设置页和 Composer 拿到的都是 realpath（桌面与 CLI 一致跟随链接），
 * 因此经链接导入到 YCode 技能根的技能会被识别为其真实来源，而不是统一显示为 YCode。
 */
export function classifySkillHubSource(input: {
  path: string;
  scope?: "workspace" | "user" | "plugin";
  pluginName?: string;
}): SkillHubSource {
  if (input.scope === "plugin") {
    const pluginName = input.pluginName?.trim();
    return pluginName ? { kind: "plugin", pluginName } : { kind: "plugin" };
  }
  const normalized = normalizeSkillHubPath(input.path);
  const lower = normalized.toLowerCase();
  const pluginCacheMarker = "/.claude/plugins/cache/";
  const pluginCacheIndex = lower.indexOf(pluginCacheMarker);
  if (pluginCacheIndex >= 0) {
    // cache/<marketplace>/<plugin>/<version>/...：插件名取 marketplace 之后的一段，保留原始大小写。
    const rest = normalized.slice(pluginCacheIndex + pluginCacheMarker.length).split("/");
    const pluginName = rest[1]?.trim();
    return pluginName ? { kind: "claudePlugin", pluginName } : { kind: "claudePlugin" };
  }
  if (lower.includes("/.claude/plugins/")) return { kind: "claudePlugin" };
  if (lower.includes("/.claude/skills/")) return { kind: "claude" };
  if (lower.includes("/.codex/skills/")) return { kind: "codex" };
  if (lower.includes("/.agents/skills/")) return { kind: "agents" };
  return { kind: "ycode" };
}

/** 来源标文案：品牌名不随语言变化；插件显示插件名。 */
export function formatSkillHubSourceLabel(
  source: SkillHubSource,
  pluginFallback = "Plugin",
): string {
  switch (source.kind) {
    case "ycode":
      return "YCode";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "agents":
      return "Agents";
    case "claudePlugin":
      return source.pluginName ?? "Claude";
    case "plugin":
      return source.pluginName ?? pluginFallback;
  }
}

/** 来源筛选使用的粗粒度分类：Claude 插件归入 Claude 之外的“插件”。 */
export type SkillHubSourceFilter = "all" | "ycode" | "claude" | "codex" | "agents" | "plugin";

export function matchesSkillHubSourceFilter(
  source: SkillHubSource,
  filter: SkillHubSourceFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "plugin") return source.kind === "plugin" || source.kind === "claudePlugin";
  return source.kind === filter;
}

export interface SkillsHubConflictVariant {
  /** 变体代表的真实目录（规范化）。 */
  realDir: string;
  source: SkillHubSource;
  /** 同内容合并进该变体的其他来源。 */
  memberSources: SkillHubSource[];
}

export interface SkillsHubConflict {
  nameKey: string;
  name: string;
  /** 当前生效的变体真实目录。 */
  chosenRealDir: string;
  /** 按来源优先级的默认变体。 */
  defaultRealDir: string;
  /** 是否来自用户选择（而非默认）。 */
  userChosen: boolean;
  variants: SkillsHubConflictVariant[];
}

export type SkillsHubPruneReason = "agents" | "duplicate" | "conflictLoser";

export interface SkillsHubPruneCandidate {
  /** YCode 技能根下的条目名（只会是链接）。 */
  entryName: string;
  target: string;
  reason: SkillsHubPruneReason;
  managed: boolean;
}

export type SkillsHubIssueCode =
  | "scan_failed"
  | "link_failed"
  | "unlink_failed"
  | "name_unavailable";

export interface SkillsHubIssue {
  code: SkillsHubIssueCode;
  message: string;
  path?: string;
}

export interface SkillsHubNewSkill {
  nameKey: string;
  name: string;
  source: SkillHubSource;
}

export interface SkillsHubState {
  /** 仅桌面用户范围可用；否则其余字段为空。 */
  available: boolean;
  syncedAt?: number;
  /** 当前受管链接数。 */
  managedLinkCount: number;
  /** 本次同步新建/删除的受管链接数。 */
  createdCount: number;
  removedCount: number;
  conflicts: SkillsHubConflict[];
  pruneCandidates: SkillsHubPruneCandidate[];
  newSkills: SkillsHubNewSkill[];
  issues: SkillsHubIssue[];
}

export function createUnavailableSkillsHubState(): SkillsHubState {
  return {
    available: false,
    managedLinkCount: 0,
    createdCount: 0,
    removedCount: 0,
    conflicts: [],
    pruneCandidates: [],
    newSkills: [],
    issues: [],
  };
}

export interface SkillsHubManifestLink {
  target: string;
  nameKey: string;
  source: SkillHubSourceKind;
  createdAt: number;
}

export interface SkillsHubManifest {
  version: 1;
  links: Record<string, SkillsHubManifestLink>;
  /** 为 undefined 表示从未同步过（首次同步只建立基线，不产生“新发现”）。 */
  seenSkillKeys?: string[];
  pendingNewSkillKeys: string[];
}

export function createEmptySkillsHubManifest(): SkillsHubManifest {
  return { version: 1, links: {}, pendingNewSkillKeys: [] };
}

const SOURCE_KINDS = new Set<string>(Object.keys(SKILL_HUB_SOURCE_PRIORITY));

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** 清单是外部文件，逐字段校验；任何无法识别的条目丢弃（丢弃=不再视为受管，绝不删除）。 */
export function parseSkillsHubManifest(value: unknown): SkillsHubManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptySkillsHubManifest();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return createEmptySkillsHubManifest();
  const links: Record<string, SkillsHubManifestLink> = {};
  const rawLinks = record.links;
  if (typeof rawLinks === "object" && rawLinks !== null && !Array.isArray(rawLinks)) {
    for (const [name, raw] of Object.entries(rawLinks as Record<string, unknown>)) {
      if (!isSafeEntryName(name) || typeof raw !== "object" || raw === null) continue;
      const link = raw as Record<string, unknown>;
      if (typeof link.target !== "string" || link.target.length === 0) continue;
      if (typeof link.nameKey !== "string") continue;
      if (typeof link.source !== "string" || !SOURCE_KINDS.has(link.source)) continue;
      links[name] = {
        target: link.target,
        nameKey: link.nameKey,
        source: link.source as SkillHubSourceKind,
        createdAt: typeof link.createdAt === "number" ? link.createdAt : 0,
      };
    }
  }
  return {
    version: 1,
    links,
    ...(Array.isArray(record.seenSkillKeys)
      ? { seenSkillKeys: readStringList(record.seenSkillKeys) }
      : {}),
    pendingNewSkillKeys: readStringList(record.pendingNewSkillKeys),
  };
}

/** 条目名只能是单段名字，防止清单被篡改后把删除指向技能根之外。 */
export function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}
