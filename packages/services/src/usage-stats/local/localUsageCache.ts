import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  appUsageExternalSessionSchema,
  appUsageFactSchema,
  type AppUsageExternalSession,
  type AppUsageFact,
} from "@zcode/shared";
import { atomicWriteText } from "../../fs/atomicFileUtils.js";
import { codexParserStateSchema, type CodexParserState, type LocalLogEntry } from "./logEntries.js";

export type LocalLogEngine = "claude-code" | "codex";

/** 单个日志文件的增量游标与已解析请求。 */
export interface LocalLogFileState {
  engine: LocalLogEngine;
  mtimeMs: number;
  size: number;
  offset: number;
  tailHash: string;
  codexState: CodexParserState | null;
  entries: LocalLogEntry[];
}

export interface LocalUsageCacheState {
  files: Map<string, LocalLogFileState>;
  zcodeFacts: AppUsageFact[];
  zcodeFactsTimeZone: string | null;
  externalSessions: AppUsageExternalSession[];
}

export function createEmptyCacheState(): LocalUsageCacheState {
  return { files: new Map(), zcodeFacts: [], zcodeFactsTimeZone: null, externalSessions: [] };
}

const CACHE_VERSION = 1;

// 紧凑存储：字符串进字符串表，记录存为定长元组，减少大量请求时的缓存体积。
// [timestamp, model, sessionId, cwd, input, output, cacheRead, cw5m, cw1h, dedupKey, final]
const compactEntrySchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.union([z.literal(0), z.literal(1)]),
]);

const cacheFileSchema = z.object({
  version: z.literal(CACHE_VERSION),
  strings: z.array(z.string()),
  files: z.record(
    z.string(),
    z.object({
      engine: z.enum(["claude-code", "codex"]),
      mtimeMs: z.number(),
      size: z.number(),
      offset: z.number(),
      tailHash: z.string(),
      codexState: codexParserStateSchema.nullable(),
      entries: z.array(compactEntrySchema),
    }),
  ),
  zcodeFacts: z.array(appUsageFactSchema),
  zcodeFactsTimeZone: z.string().nullable(),
  externalSessions: z.array(appUsageExternalSessionSchema),
});

export function serializeCacheState(state: LocalUsageCacheState): string {
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const ref = (value: string | null): number => {
    if (value === null) return -1;
    let index = indexes.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      indexes.set(value, index);
    }
    return index;
  };
  const files: Record<string, unknown> = {};
  for (const [path, file] of state.files) {
    files[path] = {
      engine: file.engine,
      mtimeMs: file.mtimeMs,
      size: file.size,
      offset: file.offset,
      tailHash: file.tailHash,
      codexState: file.codexState,
      entries: file.entries.map((entry) => [
        entry.timestamp,
        ref(entry.model),
        ref(entry.sessionId),
        ref(entry.cwd),
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens,
        entry.cacheWrite5mTokens,
        entry.cacheWrite1hTokens,
        ref(entry.dedupKey),
        entry.final ? 1 : 0,
      ]),
    };
  }
  return JSON.stringify({
    version: CACHE_VERSION,
    strings,
    files,
    zcodeFacts: state.zcodeFacts,
    zcodeFactsTimeZone: state.zcodeFactsTimeZone,
    externalSessions: state.externalSessions,
  });
}

export function deserializeCacheState(text: string): LocalUsageCacheState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = cacheFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { strings } = parsed.data;
  const str = (index: number): string | null => (index >= 0 ? (strings[index] ?? null) : null);
  const files = new Map<string, LocalLogFileState>();
  for (const [path, file] of Object.entries(parsed.data.files)) {
    files.set(path, {
      engine: file.engine,
      mtimeMs: file.mtimeMs,
      size: file.size,
      offset: file.offset,
      tailHash: file.tailHash,
      codexState: file.codexState,
      entries: file.entries.map((tuple) => ({
        timestamp: tuple[0],
        model: str(tuple[1]) ?? "unknown",
        sessionId: str(tuple[2]),
        cwd: str(tuple[3]),
        inputTokens: tuple[4],
        outputTokens: tuple[5],
        cacheReadTokens: tuple[6],
        cacheWrite5mTokens: tuple[7],
        cacheWrite1hTokens: tuple[8],
        dedupKey: str(tuple[9]),
        final: tuple[10] === 1,
      })),
    });
  }
  return {
    files,
    zcodeFacts: parsed.data.zcodeFacts,
    zcodeFactsTimeZone: parsed.data.zcodeFactsTimeZone,
    externalSessions: parsed.data.externalSessions,
  };
}

/** 缓存缺失、损坏或版本不符时返回空状态（随后全量重扫）。 */
export async function loadCacheState(cacheFile: string): Promise<LocalUsageCacheState> {
  try {
    const text = await readFile(cacheFile, "utf8");
    return deserializeCacheState(text) ?? createEmptyCacheState();
  } catch {
    return createEmptyCacheState();
  }
}

export async function saveCacheState(cacheFile: string, state: LocalUsageCacheState): Promise<void> {
  await atomicWriteText(cacheFile, serializeCacheState(state));
}
