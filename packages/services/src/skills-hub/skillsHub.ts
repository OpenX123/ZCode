/**
 * Skills Hub 引擎：受管链接与清单的唯一写入者。
 * 顺序：读清单 → 校验受管链接（失效的只删链接）→ 扫描 → 纯函数计划 → 删多余受管链接 → 建链接 → 写清单。
 * 规则来源：docs/skills-hub-spec.md。
 */
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Emitter } from "@zcode/rpc";
import {
  createEmptySkillsHubManifest,
  createUnavailableSkillsHubState,
  isSafeEntryName,
  normalizeSkillHubPath,
  parseSkillsHubManifest,
  planSkillsHub,
  type SkillsHubIssue,
  type SkillsHubManifest,
  type SkillsHubPlan,
  type SkillsHubState,
} from "@zcode/shared/skills-hub";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { createDirectorySymlink } from "../settings-sync/settingsSyncService.js";
import type { ISkillsHub, SkillsHubOptions } from "./contract.js";
import {
  resolveSkillsHubPaths,
  scanSkillsHubSources,
  type SkillsHubPaths,
} from "./skillsHubScan.js";

const log = createServiceLogger("skills-hub");
const MANIFEST_FILE_NAME = "skills-hub.json";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Windows junction 的 readlink 可能带 `\\?\` / `\??\` 前缀，比较前去掉。 */
function stripDevicePrefix(path: string): string {
  return path.replace(/^\\\\\?\\|^\\\?\?\\/u, "");
}

interface SyncOutcome {
  state: SkillsHubState;
  plan: SkillsHubPlan;
}

export function createSkillsHub(options: SkillsHubOptions): ISkillsHub {
  const platform = options.platform ?? process.platform;
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const now = options.now ?? Date.now;
  const emitter = new Emitter<SkillsHubState>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastState: SkillsHubState | null = null;

  const samePath = (left: string, right: string) => {
    const normalize = (value: string) => {
      const normalized = normalizeSkillHubPath(stripDevicePrefix(value));
      return caseInsensitive ? normalized.toLowerCase() : normalized;
    };
    return normalize(left) === normalize(right);
  };

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  const manifestPath = (paths: SkillsHubPaths) =>
    join(dirname(paths.ycodeRoot), MANIFEST_FILE_NAME);

  async function readManifest(
    paths: SkillsHubPaths,
  ): Promise<{ manifest: SkillsHubManifest; existed: boolean }> {
    try {
      const raw = await readFile(manifestPath(paths), "utf-8");
      return { manifest: parseSkillsHubManifest(JSON.parse(raw)), existed: true };
    } catch {
      return { manifest: createEmptySkillsHubManifest(), existed: false };
    }
  }

  async function writeManifest(paths: SkillsHubPaths, manifest: SkillsHubManifest): Promise<void> {
    const target = manifestPath(paths);
    const temp = `${target}.${process.pid}.${now()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    await rename(temp, target);
  }

  /** 当前条目仍是指向清单目标的链接时才算受管；否则视为用户已接管。 */
  async function isIntactManagedLink(path: string, target: string): Promise<boolean> {
    const info = await lstat(path).catch(() => null);
    if (!info?.isSymbolicLink()) return false;
    const pointsTo = await readlink(path).catch(() => null);
    return pointsTo !== null && samePath(pointsTo, target);
  }

  async function unlinkManaged(
    path: string,
    target: string,
    issues: SkillsHubIssue[],
  ): Promise<boolean> {
    // 删除前再次确认仍是指向清单目标的链接：只删链接本体，绝不删除真实目录。
    if (!(await isIntactManagedLink(path, target))) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      issues.push({ code: "unlink_failed", message: errorMessage(error), path });
      return false;
    }
  }

  async function runSync(): Promise<SyncOutcome> {
    const paths = await resolveSkillsHubPaths(options.homeDir());
    const issues: SkillsHubIssue[] = [];
    const { manifest, existed } = await readManifest(paths);
    let removedCount = 0;
    let createdCount = 0;

    // 1) 校验受管链接：被用户替换/改指向的只移出清单；源头消失的删除链接。
    for (const [name, link] of Object.entries(manifest.links)) {
      const linkPath = join(paths.ycodeRoot, name);
      if (!(await isIntactManagedLink(linkPath, link.target))) {
        delete manifest.links[name];
        continue;
      }
      const targetAlive = await stat(linkPath).then(
        () => true,
        () => false,
      );
      if (!targetAlive) {
        if (await unlinkManaged(linkPath, link.target, issues)) removedCount += 1;
        delete manifest.links[name];
      }
    }

    // 2) 扫描与计划。
    const scan = await scanSkillsHubSources({
      paths,
      managedEntryNames: new Set(Object.keys(manifest.links)),
      caseInsensitive,
    });
    issues.push(...scan.issues);
    const plan = planSkillsHub({
      members: scan.members,
      choices: await options.choices.read().catch(() => ({})),
      occupiedEntryNames: scan.occupiedEntryNames,
      managedLinks: Object.entries(manifest.links).map(([name, link]) => ({
        name,
        target: link.target,
      })),
      caseInsensitive,
    });

    // 3) 执行：先删后建，被删除的名字可以复用。
    for (const name of plan.managedLinksToRemove) {
      const link = manifest.links[name];
      if (!link) continue;
      if (await unlinkManaged(join(paths.ycodeRoot, name), link.target, issues)) {
        removedCount += 1;
        delete manifest.links[name];
      }
    }
    if (plan.linksToCreate.length > 0) {
      await mkdir(paths.ycodeRoot, { recursive: true });
    }
    for (const link of plan.linksToCreate) {
      const linkPath = join(paths.ycodeRoot, link.name);
      try {
        await createDirectorySymlink(link.target, linkPath);
        createdCount += 1;
      } catch (error) {
        // 多窗口 Host 并发同步可能已建好同一链接：指向一致则视为同一期望状态并记入清单。
        if (
          !(errorCode(error) === "EEXIST" && (await isIntactManagedLink(linkPath, link.target)))
        ) {
          issues.push({ code: "link_failed", message: errorMessage(error), path: linkPath });
          continue;
        }
      }
      manifest.links[link.name] = {
        target: link.target,
        nameKey: link.nameKey,
        source: link.source.kind,
        createdAt: now(),
      };
    }
    for (const nameKey of plan.unavailableNames) {
      issues.push({ code: "name_unavailable", message: nameKey });
    }

    // 4) 新发现：首次同步只建基线。
    const currentKeys = plan.groups.map((group) => group.nameKey);
    const currentSet = new Set(currentKeys);
    if (existed && manifest.seenSkillKeys !== undefined) {
      const seen = new Set(manifest.seenSkillKeys);
      const pending = manifest.pendingNewSkillKeys.filter((key) => currentSet.has(key));
      for (const key of currentKeys) {
        if (!seen.has(key) && !pending.includes(key)) pending.push(key);
      }
      manifest.pendingNewSkillKeys = pending;
    } else {
      manifest.pendingNewSkillKeys = [];
    }
    manifest.seenSkillKeys = currentKeys;
    await writeManifest(paths, manifest);

    const groupByKey = new Map(plan.groups.map((group) => [group.nameKey, group]));
    const state: SkillsHubState = {
      available: true,
      syncedAt: now(),
      managedLinkCount: Object.keys(manifest.links).length,
      createdCount,
      removedCount,
      conflicts: plan.conflicts,
      pruneCandidates: plan.pruneCandidates,
      newSkills: manifest.pendingNewSkillKeys.flatMap((key) => {
        const group = groupByKey.get(key);
        return group ? [{ nameKey: key, name: group.name, source: group.source }] : [];
      }),
      issues,
    };
    log.info("[skills-hub] 同步完成", {
      members: scan.members.length,
      created: createdCount,
      removed: removedCount,
      conflicts: plan.conflicts.length,
      pruneCandidates: plan.pruneCandidates.length,
      issues: issues.length,
    });
    return { state, plan };
  }

  function publish(state: SkillsHubState): SkillsHubState {
    lastState = state;
    emitter.fire(state);
    return state;
  }

  async function syncAndPublish(): Promise<SkillsHubState> {
    if (!options.isAvailable()) return createUnavailableSkillsHubState();
    return publish((await runSync()).state);
  }

  return {
    onDidChange: emitter.event,

    async getState() {
      if (lastState) return lastState;
      return enqueue(syncAndPublish);
    },

    sync() {
      return enqueue(syncAndPublish);
    },

    prune(entryNames) {
      return enqueue(async () => {
        if (!options.isAvailable()) return createUnavailableSkillsHubState();
        const paths = await resolveSkillsHubPaths(options.homeDir());
        // 服务端重新计算候选，只删“用户确认 ∩ 最新候选”，不信任 UI 传来的列表本身。
        const { plan } = await runSync();
        const confirmed = new Set(entryNames);
        const issues: SkillsHubIssue[] = [];
        for (const candidate of plan.pruneCandidates) {
          if (!confirmed.has(candidate.entryName) || !isSafeEntryName(candidate.entryName))
            continue;
          const entryPath = join(paths.ycodeRoot, candidate.entryName);
          const info = await lstat(entryPath).catch(() => null);
          // 只删链接（symlink / junction），真实目录与文件永不删除。
          if (!info?.isSymbolicLink()) continue;
          try {
            await unlink(entryPath);
          } catch (error) {
            issues.push({ code: "unlink_failed", message: errorMessage(error), path: entryPath });
          }
        }
        // 清理后再同步一次：落败链接被删除后，胜出者若不可见会立即补链接。
        const after = (await runSync()).state;
        return publish({ ...after, issues: [...issues, ...after.issues] });
      });
    },

    setConflictChoice(nameKey, realDir) {
      return enqueue(async () => {
        if (!options.isAvailable()) return createUnavailableSkillsHubState();
        const choices = { ...(await options.choices.read().catch(() => ({}))) };
        if (realDir) {
          choices[nameKey] = realDir;
        } else {
          delete choices[nameKey];
        }
        await options.choices.write(choices);
        return publish((await runSync()).state);
      });
    },

    dismissDiscoveries() {
      return enqueue(async () => {
        if (!options.isAvailable()) return createUnavailableSkillsHubState();
        const paths = await resolveSkillsHubPaths(options.homeDir());
        const { manifest } = await readManifest(paths);
        manifest.pendingNewSkillKeys = [];
        await writeManifest(paths, manifest);
        const base = lastState ?? (await runSync()).state;
        return publish({ ...base, newSkills: [] });
      });
    },
  };
}
