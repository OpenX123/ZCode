import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonlLines } from "../src/usage-stats/local/jsonlFileReader.js";
import { deserializeCacheState } from "../src/usage-stats/local/localUsageCache.js";
import {
  LOCAL_USAGE_SCAN_REUSE_MS,
  LocalUsageScanner,
  mergeZCodeFacts,
  type ZCodeNativeUsage,
} from "../src/usage-stats/local/localUsageScanner.js";

const FIXTURES = join(__dirname, "fixtures", "local-usage");
const tempDirs: string[] = [];

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "zcode-local-usage-"));
  tempDirs.push(root);
  const claudeProjects = join(root, ".claude", "projects");
  const project = join(claudeProjects, "-work-alpha");
  const codexHome = join(root, ".codex");
  const codexDay = join(codexHome, "sessions", "2026", "11", "21");
  await mkdir(join(project, "sess-zcode", "subagents"), { recursive: true });
  await mkdir(codexDay, { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  await copyFile(join(FIXTURES, "claude-session.jsonl"), join(project, "sess-cli.jsonl"));
  await copyFile(join(FIXTURES, "claude-resumed.jsonl"), join(project, "sess-zcode.jsonl"));
  await copyFile(join(FIXTURES, "codex-rollout.jsonl"), join(codexDay, "rollout-thread-cli.jsonl"));
  return {
    root,
    claudeProjects,
    project,
    codexHome,
    codexDay,
    cacheFile: join(root, "cache.json"),
  };
}

function createScanner(
  home: Awaited<ReturnType<typeof makeHome>>,
  native: () => Promise<ZCodeNativeUsage | null> = async () => null,
  clock = { now: 1_000_000 },
) {
  return new LocalUsageScanner({
    cacheFile: home.cacheFile,
    claudeProjectDirs: () => [home.claudeProjects],
    codexHome: () => home.codexHome,
    fetchZCodeNative: native,
    now: () => clock.now,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readJsonlLines（LU-05）", () => {
  it("未写完的尾行不推进游标，超长行丢弃并计数", async () => {
    const home = await makeHome();
    const file = join(home.root, "t.jsonl");
    await writeFile(file, `{"a":1}\r\n${"x".repeat(64)}\n{"b":2}\n{"partial":`);
    const lines: string[] = [];
    const result = await readJsonlLines(file, 0, (line) => lines.push(line), 32);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.oversizedLines).toBe(1);
    expect(result.endOffset).toBe(Buffer.byteLength(`{"a":1}\r\n${"x".repeat(64)}\n{"b":2}\n`));
  });
});

describe("LocalUsageScanner", () => {
  it("跨文件去重 Claude 请求，Codex 重复事件只计一次，并写入缓存（LU-01/03）", async () => {
    const home = await makeHome();
    const index = await createScanner(home).scan("UTC");
    // msg_1 在两个文件各出现（resume 复制），只计一次；msg_2、msg_3 各一条
    expect(index.claudeEntries.map((e) => e.dedupKey).sort()).toEqual([
      "msg_1:req_1",
      "msg_2:req_2",
      "msg_3:req_3",
    ]);
    expect(index.claudeEntries.find((e) => e.dedupKey === "msg_1:req_1")?.outputTokens).toBe(50);
    expect(index.codexEntries).toHaveLength(2);
    expect(index.claudeFiles).toBe(2);
    expect(index.codexFiles).toBe(1);
    expect(index.malformedLines).toBe(1);
    const cache = deserializeCacheState(await readFile(home.cacheFile, "utf8"));
    expect(cache?.files.size).toBe(3);
  });

  it("追加只读新增字节；截断改写全量重扫（LU-06）", async () => {
    const home = await makeHome();
    const clock = { now: 1_000_000 };
    const scanner = createScanner(home, async () => null, clock);
    await scanner.scan("UTC");
    const file = join(home.project, "sess-zcode.jsonl");
    await appendFile(
      file,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-21T10:00:00Z",
        sessionId: "sess-zcode",
        requestId: "req_4",
        message: {
          id: "msg_4",
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      })}\n`,
    );
    clock.now += LOCAL_USAGE_SCAN_REUSE_MS + 1;
    const appended = await scanner.scan("UTC");
    expect(appended.claudeEntries.map((e) => e.dedupKey)).toContain("msg_4:req_4");
    expect(appended.claudeEntries).toHaveLength(4);

    await writeFile(
      file,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-22T10:00:00Z",
        sessionId: "sess-zcode",
        message: {
          id: "msg_new",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
    );
    clock.now += LOCAL_USAGE_SCAN_REUSE_MS + 1;
    const rewritten = await scanner.scan("UTC");
    const keys = rewritten.claudeEntries.map((e) => e.dedupKey);
    expect(keys).toContain("msg_new");
    expect(keys).not.toContain("msg_3:req_3");
    expect(keys).not.toContain("msg_4:req_4");
    // msg_1 仍由 sess-cli.jsonl 提供
    expect(keys).toContain("msg_1:req_1");
  });

  it("新实例从缓存恢复游标，不重复计数；文件删除后移除其记录", async () => {
    const home = await makeHome();
    await createScanner(home).scan("UTC");
    const reloaded = await createScanner(home).scan("UTC");
    expect(reloaded.claudeEntries).toHaveLength(3);
    await rm(join(home.project, "sess-cli.jsonl"));
    const afterDelete = await createScanner(home).scan("UTC");
    expect(afterDelete.claudeEntries.map((e) => e.dedupKey).sort()).toEqual([
      "msg_1:req_1",
      "msg_3:req_3",
    ]);
  });

  it("并发扫描单飞，5s 内复用索引", async () => {
    const home = await makeHome();
    const native = vi.fn(async () => null);
    const scanner = createScanner(home, native);
    const [a, b] = await Promise.all([scanner.scan("UTC"), scanner.scan("UTC")]);
    expect(a).toBe(b);
    await scanner.scan("UTC");
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("CLI 不可用时沿用缓存的原生聚合与会话映射（LU-08）", async () => {
    const home = await makeHome();
    const fact = {
      date: "2026-11-20",
      modelId: "glm-4.6",
      cwd: "/work/native",
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 50,
      requestCount: 2,
    };
    await createScanner(home, async () => ({
      facts: [fact],
      externalSessions: [{ engine: "claude-code", externalSessionId: "sess-zcode" }],
    })).scan("UTC");
    const offline = await createScanner(home, async () => null).scan("UTC");
    expect(offline.zcodeNativeAvailable).toBe(false);
    expect(offline.zcodeFacts).toEqual([fact]);
    expect(offline.externalSessions).toEqual([
      { engine: "claude-code", externalSessionId: "sess-zcode" },
    ]);
  });

  it("原生按日聚合合并：同日期取请求数更大的一份", () => {
    const base = {
      modelId: "m",
      cwd: null,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    const merged = mergeZCodeFacts(
      [
        { ...base, date: "2026-10-01", requestCount: 5 },
        { ...base, date: "2026-10-20", requestCount: 9 },
      ],
      [
        { ...base, date: "2026-10-20", requestCount: 3 },
        { ...base, date: "2026-11-01", requestCount: 1 },
      ],
    );
    expect(merged.map((f) => [f.date, f.requestCount])).toEqual([
      ["2026-10-01", 5],
      ["2026-10-20", 9],
      ["2026-11-01", 1],
    ]);
  });
});
