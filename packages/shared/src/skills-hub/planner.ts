/**
 * Skills Hub 同步计划（纯函数）：分组、变体、冲突胜出者、受管链接对账与手动清理候选。
 * 输入是 services 扫描出的事实，输出是要执行的文件操作；这里不做任何 I/O，便于穷举测试。
 * 规则来源：docs/skills-hub-spec.md「去重与冲突」「链接布局」「自动清理与手动清理」。
 */
import {
  SKILL_HUB_SOURCE_PRIORITY,
  isSafeEntryName,
  normalizeSkillHubPath,
  type SkillHubSource,
  type SkillsHubConflict,
  type SkillsHubPruneCandidate,
} from "./contract.js";

export interface SkillsHubEntryRef {
  /** YCode 技能根下的顶层条目名。 */
  name: string;
  isLink: boolean;
  /** 是否为清单中且校验通过的受管链接。 */
  managed: boolean;
}

export interface SkillsHubMember {
  /** 规范化后的真实目录，作为成员身份。 */
  realDir: string;
  name: string;
  nameKey: string;
  /** SKILL.md 内容哈希；读取失败时为空串，此时退回用 realDir 区分变体。 */
  contentHash: string;
  source: SkillHubSource;
  /** YCode 不经链接即可读取（agents 根、YCode 根下的真实目录）。 */
  directlyVisible: boolean;
  /** YCode 技能根中解析到该成员的条目。 */
  entries: SkillsHubEntryRef[];
  /** 建链接时优先使用的名字（源技能目录名）。 */
  preferredLinkName: string;
}

export interface SkillsHubManagedLinkRef {
  name: string;
  /** 规范化后的目标真实目录。 */
  target: string;
}

export interface SkillsHubPlanInput {
  members: SkillsHubMember[];
  /** nameKey → 用户选择的真实目录。 */
  choices: Readonly<Record<string, string>>;
  /** YCode 技能根下所有现有条目名（含非技能条目）。 */
  occupiedEntryNames: readonly string[];
  /** 已校验仍然完好的受管链接。 */
  managedLinks: readonly SkillsHubManagedLinkRef[];
  /** 路径比较是否忽略大小写（Windows / macOS 默认文件系统）。 */
  caseInsensitive?: boolean;
}

export interface SkillsHubLinkToCreate {
  name: string;
  target: string;
  nameKey: string;
  source: SkillHubSource;
}

export interface SkillsHubPlan {
  conflicts: SkillsHubConflict[];
  linksToCreate: SkillsHubLinkToCreate[];
  /** 需要删除的受管链接条目名。 */
  managedLinksToRemove: string[];
  /** 手动清理候选（只会是链接条目）。 */
  pruneCandidates: SkillsHubPruneCandidate[];
  /** 找不到可用名字而无法建链接的分组。 */
  unavailableNames: string[];
  /** 当前所有分组 key 与显示名、代表来源（用于“新发现”）。 */
  groups: Array<{ nameKey: string; name: string; source: SkillHubSource }>;
}

interface Variant {
  key: string;
  members: SkillsHubMember[];
  priority: number;
  representative: SkillsHubMember;
}

const LINKABLE_KINDS = new Set(["claude", "claudePlugin", "codex"]);
const MAX_NAME_ATTEMPTS = 20;

function priorityOf(member: SkillsHubMember): number {
  return SKILL_HUB_SOURCE_PRIORITY[member.source.kind];
}

function compareMembers(left: SkillsHubMember, right: SkillsHubMember): number {
  return priorityOf(left) - priorityOf(right) || left.realDir.localeCompare(right.realDir);
}

function buildVariants(members: SkillsHubMember[]): Variant[] {
  const byKey = new Map<string, SkillsHubMember[]>();
  for (const member of members) {
    const key = member.contentHash || `dir:${member.realDir}`;
    byKey.set(key, [...(byKey.get(key) ?? []), member]);
  }
  return [...byKey.entries()]
    .map(([key, variantMembers]) => {
      const sorted = variantMembers.toSorted(compareMembers);
      const representative = sorted[0]!;
      return { key, members: sorted, priority: priorityOf(representative), representative };
    })
    .toSorted(
      (left, right) =>
        left.priority - right.priority ||
        left.representative.realDir.localeCompare(right.representative.realDir),
    );
}

function sourceSuffix(source: SkillHubSource): string {
  if (source.kind === "claudePlugin" || source.kind === "plugin") {
    return source.pluginName ?? source.kind;
  }
  return source.kind;
}

/** 变体内保留的入口：直接可见成员优先，其次非链接条目、来源优先级、名字匹配、字母序。 */
function chooseVariantKeeper(variant: Variant): { member: SkillsHubMember; entry?: string } | null {
  const direct = variant.members.find((member) => member.directlyVisible);
  if (direct) return { member: direct };
  const candidates = variant.members.flatMap((member) =>
    member.entries.filter((entry) => !entry.managed).map((entry) => ({ member, entry })),
  );
  candidates.sort(
    (left, right) =>
      Number(left.entry.isLink) - Number(right.entry.isLink) ||
      priorityOf(left.member) - priorityOf(right.member) ||
      Number(right.entry.name === right.member.preferredLinkName) -
        Number(left.entry.name === left.member.preferredLinkName) ||
      left.entry.name.localeCompare(right.entry.name),
  );
  const first = candidates[0];
  return first ? { member: first.member, entry: first.entry.name } : null;
}

export function planSkillsHub(input: SkillsHubPlanInput): SkillsHubPlan {
  const key = (path: string) => {
    const normalized = normalizeSkillHubPath(path);
    return input.caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const occupied = new Set(input.occupiedEntryNames.map((name) => name.toLowerCase()));
  const managedByName = new Map(input.managedLinks.map((link) => [link.name, link]));
  const memberDirs = new Set(input.members.map((member) => key(member.realDir)));
  const keepManaged = new Set<string>();
  const linksToCreate: SkillsHubLinkToCreate[] = [];
  const conflicts: SkillsHubConflict[] = [];
  const pruneCandidates: SkillsHubPruneCandidate[] = [];
  const unavailableNames: string[] = [];
  const groups: SkillsHubPlan["groups"] = [];

  const membersByGroup = new Map<string, SkillsHubMember[]>();
  for (const member of input.members) {
    membersByGroup.set(member.nameKey, [...(membersByGroup.get(member.nameKey) ?? []), member]);
  }
  const managedToRemove = new Set<string>();
  // 目标已不在任何成员中的受管链接（源头消失或改名）直接移除。
  for (const link of input.managedLinks) {
    if (!memberDirs.has(key(link.target))) managedToRemove.add(link.name);
  }

  const pendingCreates: Array<{ nameKey: string; member: SkillsHubMember }> = [];

  for (const [nameKey, groupMembers] of [...membersByGroup.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const variants = buildVariants(groupMembers);
    const defaultVariant = variants[0]!;
    const choice = input.choices[nameKey];
    const chosenVariant = choice
      ? variants.find((variant) =>
          variant.members.some((member) => key(member.realDir) === key(choice)),
        )
      : undefined;
    const winner = chosenVariant ?? defaultVariant;
    groups.push({
      nameKey,
      name: winner.representative.name,
      source: winner.representative.source,
    });

    if (variants.length > 1) {
      conflicts.push({
        nameKey,
        name: winner.representative.name,
        chosenRealDir: winner.representative.realDir,
        defaultRealDir: defaultVariant.representative.realDir,
        userChosen: chosenVariant !== undefined,
        variants: variants.map((variant) => ({
          realDir: variant.representative.realDir,
          source: variant.representative.source,
          memberSources: variant.members.slice(1).map((member) => member.source),
        })),
      });
    }

    // 1) 胜出者是否已经“非受管可见”：是则不需要任何受管链接。
    const winnerVisibleUnmanaged = winner.members.some(
      (member) => member.directlyVisible || member.entries.some((entry) => !entry.managed),
    );
    if (!winnerVisibleUnmanaged) {
      const linkable = winner.members.filter((member) => LINKABLE_KINDS.has(member.source.kind));
      const target = linkable[0];
      if (target) {
        const existing = target.entries.find((entry) => entry.managed);
        if (existing) {
          keepManaged.add(existing.name);
        } else {
          pendingCreates.push({ nameKey, member: target });
        }
      }
    }

    // 2) 组内其余受管链接全部对账删除（切换选择、重复、胜出者已直接可见）。
    for (const member of groupMembers) {
      for (const entry of member.entries) {
        if (entry.managed && !keepManaged.has(entry.name)) managedToRemove.add(entry.name);
      }
    }

    // 3) 手动清理候选：只考虑非受管的链接条目，真实目录永不进入候选。
    for (const variant of variants) {
      const keeper = chooseVariantKeeper(variant);
      for (const member of variant.members) {
        for (const entry of member.entries) {
          if (!entry.isLink || entry.managed || !isSafeEntryName(entry.name)) continue;
          const reason =
            member.source.kind === "agents"
              ? "agents"
              : variant !== winner
                ? "conflictLoser"
                : keeper && keeper.entry !== entry.name
                  ? "duplicate"
                  : null;
          if (reason) {
            pruneCandidates.push({
              entryName: entry.name,
              target: member.realDir,
              reason,
              managed: false,
            });
          }
        }
      }
    }
  }

  // 删除先于创建：被删除的受管链接名可以复用。
  const managedNamesToRemove = [...managedToRemove].filter((name) => managedByName.has(name));
  for (const name of managedNamesToRemove) occupied.delete(name.toLowerCase());

  for (const { nameKey, member } of pendingCreates) {
    const base = member.preferredLinkName;
    const suffix = sourceSuffix(member.source);
    const attempts = [base, `${base}-${suffix}`];
    for (let index = 2; attempts.length < MAX_NAME_ATTEMPTS; index += 1) {
      attempts.push(`${base}-${suffix}-${index}`);
    }
    const name = attempts.find(
      (candidate) => isSafeEntryName(candidate) && !occupied.has(candidate.toLowerCase()),
    );
    if (!name) {
      unavailableNames.push(nameKey);
      continue;
    }
    occupied.add(name.toLowerCase());
    linksToCreate.push({ name, target: member.realDir, nameKey, source: member.source });
  }

  return {
    conflicts,
    linksToCreate,
    managedLinksToRemove: managedNamesToRemove.toSorted(),
    pruneCandidates: pruneCandidates.toSorted((left, right) =>
      left.entryName.localeCompare(right.entryName),
    ),
    unavailableNames,
    groups,
  };
}
