import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexParserState,
  parseClaudeLine,
  parseCodexLine,
  preferClaudeEntry,
  type LocalLogEntry,
} from "../src/usage-stats/local/logEntries.js";
import {
  computeCostUsd,
  normalizeModelId,
  resolveModelPrice,
} from "../src/usage-stats/local/modelPricing.js";
import { parseModelsDevPrices } from "../src/usage-stats/local/modelPricingStore.js";

const FIXTURES = join(__dirname, "fixtures", "local-usage");
const readLines = (name: string) =>
  readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);

describe("Claude Code 日志解析（LU-01/02/05）", () => {
  it("只取 assistant usage 行，跳过 <synthetic> 与非 assistant 行，损坏行计为 malformed", () => {
    const results = readLines("claude-session.jsonl").map((line) =>
      parseClaudeLine(line, "fallback"),
    );
    const entries = results.filter((r): r is LocalLogEntry => typeof r === "object");
    expect(entries).toHaveLength(3);
    expect(results.filter((r) => r === "malformed")).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: "sess-cli",
      cwd: "/work/alpha",
      dedupKey: "msg_1:req_1",
      final: false,
      outputTokens: 5,
    });
  });

  it("1h 缓存写入与 5m 分开记", () => {
    const line = readLines("claude-session.jsonl").find((l) => l.includes("msg_2"))!;
    const entry = parseClaudeLine(line, null) as LocalLogEntry;
    expect(entry.cacheWrite1hTokens).toBe(2000);
    expect(entry.cacheWrite5mTokens).toBe(1000);
  });

  it("同一 message.id 优先 stop_reason 行，否则取 output 更大者", () => {
    const base = parseClaudeLine(readLines("claude-session.jsonl")[2]!, null) as LocalLogEntry;
    const final = { ...base, final: true, outputTokens: 1 };
    expect(preferClaudeEntry(base, final)).toBe(final);
    const bigger = { ...base, outputTokens: 999 };
    expect(preferClaudeEntry(base, bigger)).toBe(bigger);
    expect(preferClaudeEntry(final, bigger)).toBe(final);
  });

  it("行内缺 sessionId 时使用路径推导的会话 ID", () => {
    const entry = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-20T00:00:00Z",
        message: {
          id: "m",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      "parent-session",
    ) as LocalLogEntry;
    expect(entry.sessionId).toBe("parent-session");
    expect(entry.dedupKey).toBe("m");
  });
});

describe("Codex 日志解析（LU-03/04）", () => {
  it("取 session_meta/turn_context 状态，跳过重复签名，按高水位差补算并截断 cached", () => {
    const state = createCodexParserState();
    const results = readLines("codex-rollout.jsonl").map((line) => parseCodexLine(line, state));
    const entries = results.filter((r): r is LocalLogEntry => typeof r === "object");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      sessionId: "thread-cli",
      cwd: "/work/gamma",
      model: "gpt-5.1-codex",
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 100,
    });
    // 只有 total：input 差 500，cached 差 1400 截断为 500
    expect(entries[1]).toMatchObject({ inputTokens: 0, cacheReadTokens: 500, outputTokens: 50 });
    expect(state.lastTotal?.total).toBe(1650);
  });

  it("没有 turn_context 时回退 gpt-5", () => {
    const state = createCodexParserState();
    const entry = parseCodexLine(
      JSON.stringify({
        timestamp: "2026-11-21T00:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        },
      }),
      state,
    ) as LocalLogEntry;
    expect(entry.model).toBe("gpt-5");
  });
});

describe("模型 ID 归一化与查价（LU-09）", () => {
  it.each([
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4.5"],
    ["claude-opus-4-1", "claude-opus-4.1"],
    ["claude-sonnet-4-20250514", "claude-sonnet-4"],
    ["claude-3-5-sonnet-20241022", "claude-3.5-sonnet"],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4.5"],
    ["anthropic/claude-opus-4.5", "claude-opus-4.5"],
    ["claude-opus-4-6[1m]", "claude-opus-4.6"],
    ["openai/GPT-5.1-Codex", "gpt-5.1-codex"],
    ["", "unknown"],
  ])("%s → %s", (raw, normalized) => {
    expect(normalizeModelId(raw)).toBe(normalized);
  });

  it("按 - 边界前缀匹配，不把 gpt-5.5 误配为 gpt-5", () => {
    expect(resolveModelPrice("gpt-5.1-codex-max", { manual: {}, synced: {} })?.price.input).toBe(
      1.25,
    );
    expect(resolveModelPrice("gpt-5.5", { manual: {}, synced: {} })).toBeNull();
  });

  it("手动 > 同步 > 内置", () => {
    const manual = { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 };
    const synced = { input: 8, output: 8, cacheRead: 0, cacheWrite: 0 };
    expect(resolveModelPrice("gpt-5", { manual: {}, synced: {} })?.origin).toBe("builtin");
    expect(resolveModelPrice("gpt-5", { manual: {}, synced: { "gpt-5": synced } })?.origin).toBe(
      "synced",
    );
    expect(
      resolveModelPrice("gpt-5", { manual: { "gpt-5": manual }, synced: { "gpt-5": synced } }),
    ).toEqual({ price: manual, origin: "manual" });
  });

  it("费用按每百万 token 计，1h 写入单独计价", () => {
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 };
    expect(
      computeCostUsd(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWrite5mTokens: 1_000_000,
          cacheWrite1hTokens: 1_000_000,
        },
        price,
      ),
    ).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6);
  });

  it("解析 models.dev 价格，Claude 1h 写入 = 2 × input", () => {
    const prices = parseModelsDevPrices({
      anthropic: {
        models: {
          "claude-sonnet-4-5-20250929": {
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          },
        },
      },
      openai: { models: { "gpt-5": { cost: { input: 1.25, output: 10, cache_read: 0.125 } } } },
      other: { models: { "x-model": { cost: { input: 1, output: 1 } } } },
    });
    expect(prices["claude-sonnet-4.5"]).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      cacheWrite1h: 6,
    });
    expect(prices["gpt-5"]).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 });
    expect(prices["x-model"]).toBeUndefined();
    expect(() => parseModelsDevPrices("bad")).toThrow();
  });
});
