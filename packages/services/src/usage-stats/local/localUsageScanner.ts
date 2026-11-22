import { stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { AppUsageExternalSession, AppUsageFact } from "@zcode/shared";
import {
  loadCacheState,
  saveCacheState,
  type LocalLogEngine,
  type LocalLogFileState,
  type LocalUsageCacheState,
} from "./localUsageCache.js";
import { hashTailBefore, listJsonlFiles, readJsonlLines } from "./jsonlFileReader.js";
import {
  createCodexParserState,
  parseClaudeLine,
  parseCodexLine,
  preferClaudeEntry,
  type LocalLogEntry,
} from "./logEntries.js";

/** 两次扫描的最小间隔：并发或紧邻的请求复用同一份索引。 */
export const LOCAL_USAGE_SCAN_REUSE_MS = 5_000;
const CLAUDE_MAX_DEPTH = 6;
const CODEX_MAX_DEPTH = 5;

export interface ZCodeNativeUsage {
  facts: AppUsageFact[];
  externalSessions: AppUsageExternalSession[];
}

export interface LocalUsageScannerOptions {
  cacheFile: string;
  claudeProjectDirs: () => string[];
  codexHome: () => string;
  /** 读取 CLI usage store；不可用时返回 null（沿用缓存）。 */
  fetchZCodeNative: (timeZone: string) => Promise<ZCodeNativeUsage | null>;
  now?: () => number;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

/** 一次扫描后的只读视图：日志请求已跨文件去重。 */
export interface LocalUsageIndex {
  claudeEntries: LocalLogEntry[];
  codexEntries: LocalLogEntry[];
  zcodeFacts: AppUsageFact[];
  externalSessions: AppUsageExternalSession[];
  claudeFiles: number;
  codexFiles: number;
  malformedLines: number;
  zcodeNativeAvailable: boolean;
  scannedAt: number;
  durationMs: number;
}

function claudeFallbackSessionId(root: string, file: string): string | null {
  // projects/<project>/<session>.jsonl → session；projects/<project>/<session>/subagents/... → session
  const segments = relative(root, file).split(sep);
  if (segments.length === 2) return basename(file, ".jsonl");
  return segments[1] ?? null;
}

/** 同一日期取请求数更大的一份：CLI 30 天裁剪只会让旧日期变少，缓存因此能保留更久的历史。 */
export function mergeZCodeFacts(cached: AppUsageFact[], fresh: AppUsageFact[]): AppUsageFact[] {
  const group = (facts: AppUsageFact[]) => {
    const byDate = new Map<string, AppUsageFact[]>();
    for (const fact of facts) byDate.set(fact.date, [...(byDate.get(fact.date) ?? []), fact]);
    return byDate;
  };
  const requests = (facts: AppUsageFact[] | undefined) =>
    (facts ?? []).reduce((sum, fact) => sum + fact.requestCount, 0);
  const cachedByDate = group(cached);
  const freshByDate = group(fresh);
  const merged: AppUsageFact[] = [];
  for (const date of new Set([...cachedByDate.keys(), ...freshByDate.keys()])) {
    const a = cachedByDate.get(date);
    const b = freshByDate.get(date);
    merged.push(...((requests(b) >= requests(a) ? b : a) ?? []));
  }
  return merged.sort((x, y) => x.date.localeCompare(y.date));
}

function mergeExternalSessions(
  cached: AppUsageExternalSession[],
  fresh: AppUsageExternalSession[],
): AppUsageExternalSession[] {
  const byKey = new Map<string, AppUsageExternalSession>();
  for (const item of [...cached, ...fresh]) byKey.set(`${item.engine}:${item.externalSessionId}`, item);
  return [...byKey.values()];
}

/**
 * 本机日志扫描的唯一所有者：持有每文件游标与解析结果，单飞执行增量扫描并持久化缓存。
 * 只由 getLocalUsageSnapshot 驱动（统计页打开时），没有后台定时扫描。
 */
export class LocalUsageScanner {
  private state: LocalUsageCacheState | null = null;
  private inflight: Promise<LocalUsageIndex> | null = null;
  private index: LocalUsageIndex | null = null;
  private indexTimeZone: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: LocalUsageScannerOptions) {
    this.now = options.now ?? Date.now;
  }

  async scan(timeZone: string): Promise<LocalUsageIndex> {
    if (
      this.index &&
      this.indexTimeZone === timeZone &&
      this.now() - this.index.scannedAt < LOCAL_USAGE_SCAN_REUSE_MS
    ) {
      return this.index;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.runScan(timeZone).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runScan(timeZone: string): Promise<LocalUsageIndex> {
    const startedAt = this.now();
    this.state ??= await loadCacheState(this.options.cacheFile);
    const state = this.state;
    let changed = false;
    let malformedLines = 0;
    const seen = new Set<string>();

    const scanFiles = async (engine: LocalLogEngine, root: string, maxDepth: number) => {
      const files = await listJsonlFiles(root, maxDepth);
      for (const file of files) {
        seen.add(file);
        const fallbackSessionId = engine === "claude-code" ? claudeFallbackSessionId(root, file) : null;
        try {
          const result = await this.scanFile(engine, file, state.files.get(file), fallbackSessionId);
          malformedLines += result.malformedLines;
          if (result.next) {
            state.files.set(file, result.next);
            changed = true;
          }
        } catch (error) {
          // 单个文件读取失败（权限、被删除）不影响其余来源。
          this.options.warn?.("[LocalUsageScanner] 读取日志文件失败", {
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return files.length;
    };

    let claudeFiles = 0;
    for (const root of this.options.claudeProjectDirs()) {
      claudeFiles += await scanFiles("claude-code", root, CLAUDE_MAX_DEPTH);
    }
    const codexHome = this.options.codexHome();
    const codexFiles =
      (await scanFiles("codex", join(codexHome, "sessions"), CODEX_MAX_DEPTH)) +
      (await scanFiles("codex", join(codexHome, "archived_sessions"), 1));

    for (const file of [...state.files.keys()]) {
      if (!seen.has(file)) {
        state.files.delete(file);
        changed = true;
      }
    }

    let zcodeNativeAvailable = false;
    try {
      const native = await this.options.fetchZCodeNative(timeZone);
      if (native) {
        zcodeNativeAvailable = true;
        state.zcodeFacts =
          state.zcodeFactsTimeZone === timeZone
            ? mergeZCodeFacts(state.zcodeFacts, native.facts)
            : native.facts;
        state.zcodeFactsTimeZone = timeZone;
        state.externalSessions = mergeExternalSessions(state.externalSessions, native.externalSessions);
        changed = true;
      }
    } catch (error) {
      this.options.warn?.("[LocalUsageScanner] 读取 ZCode 原生用量失败，沿用缓存", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (changed) {
      try {
        await saveCacheState(this.options.cacheFile, state);
      } catch (error) {
        this.options.warn?.("[LocalUsageScanner] 写入用量缓存失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const scannedAt = this.now();
    this.index = {
      ...dedupeEntries(state),
      zcodeFacts: state.zcodeFactsTimeZone === timeZone ? state.zcodeFacts : [],
      externalSessions: state.externalSessions,
      claudeFiles,
      codexFiles,
      malformedLines,
      zcodeNativeAvailable,
      scannedAt,
      durationMs: Math.max(0, scannedAt - startedAt),
    };
    this.indexTimeZone = timeZone;
    return this.index;
  }

  /** 返回新的文件状态；无变化时 next 为 null。 */
  private async scanFile(
    engine: LocalLogEngine,
    file: string,
    previous: LocalLogFileState | undefined,
    fallbackSessionId: string | null,
  ): Promise<{ next: LocalLogFileState | null; malformedLines: number }> {
    const info = await stat(file);
    if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
      return { next: null, malformedLines: 0 };
    }
    let base: LocalLogFileState | null = null;
    if (
      previous &&
      previous.engine === engine &&
      info.size >= previous.offset &&
      (await hashTailBefore(file, previous.offset)) === previous.tailHash
    ) {
      base = previous;
    }
    // 截断或改写：全量重扫该文件，丢弃旧记录。
    const entries = base ? [...base.entries] : [];
    const codexState = base?.codexState ? { ...base.codexState } : createCodexParserState();
    let malformedLines = 0;
    const result = await readJsonlLines(file, base?.offset ?? 0, (line) => {
      const parsed =
        engine === "claude-code"
          ? parseClaudeLine(line, fallbackSessionId)
          : parseCodexLine(line, codexState);
      if (parsed === "malformed") malformedLines += 1;
      else if (parsed !== "skip") entries.push(parsed);
    });
    malformedLines += result.oversizedLines;
    return {
      next: {
        engine,
        mtimeMs: info.mtimeMs,
        size: info.size,
        offset: result.endOffset,
        tailHash: await hashTailBefore(file, result.endOffset),
        codexState: engine === "codex" ? codexState : null,
        entries,
      },
      malformedLines,
    };
  }
}

/** 跨文件去重：Claude 同键取 stop_reason/输出更大者；Codex 同键只计一次。 */
export function dedupeEntries(
  state: LocalUsageCacheState,
): Pick<LocalUsageIndex, "claudeEntries" | "codexEntries"> {
  const claudeByKey = new Map<string, LocalLogEntry>();
  const codexByKey = new Map<string, LocalLogEntry>();
  const claudeEntries: LocalLogEntry[] = [];
  const codexEntries: LocalLogEntry[] = [];
  for (const file of state.files.values()) {
    for (const entry of file.entries) {
      if (file.engine === "claude-code") {
        if (!entry.dedupKey) {
          claudeEntries.push(entry);
          continue;
        }
        const current = claudeByKey.get(entry.dedupKey);
        claudeByKey.set(entry.dedupKey, current ? preferClaudeEntry(current, entry) : entry);
      } else if (!entry.dedupKey) {
        codexEntries.push(entry);
      } else if (!codexByKey.has(entry.dedupKey)) {
        codexByKey.set(entry.dedupKey, entry);
      }
    }
  }
  return {
    claudeEntries: [...claudeEntries, ...claudeByKey.values()],
    codexEntries: [...codexEntries, ...codexByKey.values()],
  };
}
