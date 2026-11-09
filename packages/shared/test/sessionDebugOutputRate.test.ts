import { describe, expect, it } from "vitest";
import {
  aggregateTurnOutputRate,
  calculateModelCallOutputRate,
  type ModelCallOutputTiming,
} from "../src/session-debug.js";

function call(overrides: Partial<ModelCallOutputTiming> = {}): ModelCallOutputTiming {
  return {
    outputTokens: 120,
    durationMs: 3000,
    timeToFirstContentMs: 1000,
    reasoningContentStreamed: false,
    ...overrides,
  };
}

describe("calculateModelCallOutputRate", () => {
  it("生成时长 = 总时长 − 首字时间，分子为 outputTokens", () => {
    expect(calculateModelCallOutputRate(call())).toEqual({
      streamedOutputTokens: 120,
      generationMs: 2000,
    });
  });

  it("推理内容有流式输出时，分子包含推理 token", () => {
    expect(
      calculateModelCallOutputRate(
        call({ outputTokens: 300, reasoningTokens: 200, reasoningContentStreamed: true }),
      ),
    ).toEqual({ streamedOutputTokens: 300, generationMs: 2000 });
  });

  it("隐藏推理（有推理 token 但没收到推理 delta）从分子扣除推理 token", () => {
    expect(
      calculateModelCallOutputRate(
        call({ outputTokens: 300, reasoningTokens: 200, reasoningContentStreamed: false }),
      ),
    ).toEqual({ streamedOutputTokens: 100, generationMs: 2000 });
  });

  it.each<[string, Partial<ModelCallOutputTiming>]>([
    ["缺 outputTokens", { outputTokens: undefined }],
    ["缺首字时间", { timeToFirstContentMs: undefined }],
    ["缺总时长", { durationMs: undefined }],
    ["生成时长为 0", { timeToFirstContentMs: 3000 }],
    ["首字晚于结束", { timeToFirstContentMs: 4000 }],
    ["非有限值", { durationMs: Number.NaN }],
    ["负数 token", { outputTokens: -1 }],
    ["推理 token 多于输出", { outputTokens: 100, reasoningTokens: 200 }],
    ["旧事件未记录推理是否流式", { reasoningTokens: 20, reasoningContentStreamed: undefined }],
  ])("%s 时视为缺数据", (_name, overrides) => {
    expect(calculateModelCallOutputRate(call(overrides))).toBeNull();
  });

  it("没有推理 token 时，旧事件缺少推理标记也可以计算", () => {
    expect(
      calculateModelCallOutputRate(
        call({ reasoningTokens: 0, reasoningContentStreamed: undefined }),
      ),
    ).toEqual({ streamedOutputTokens: 120, generationMs: 2000 });
  });
});

describe("aggregateTurnOutputRate", () => {
  it("整轮 tokens/s = Σ分子 ÷ Σ生成时长，首字取第一次调用", () => {
    expect(
      aggregateTurnOutputRate([
        call({ outputTokens: 120, durationMs: 3100, timeToFirstContentMs: 1100 }),
        call({ outputTokens: 80, durationMs: 2500, timeToFirstContentMs: 500 }),
      ]),
    ).toEqual({ outputTps: 50, generationMs: 4000, firstTokenMs: 1100 });
  });

  it("多次调用混合隐藏推理与可见推理", () => {
    expect(
      aggregateTurnOutputRate([
        call({
          outputTokens: 300,
          reasoningTokens: 200,
          reasoningContentStreamed: false,
          durationMs: 1500,
          timeToFirstContentMs: 500,
        }),
        call({
          outputTokens: 300,
          reasoningTokens: 200,
          reasoningContentStreamed: true,
          durationMs: 3500,
          timeToFirstContentMs: 500,
        }),
      ]),
    ).toEqual({ outputTps: 100, generationMs: 4000, firstTokenMs: 500 });
  });

  it("任何一次调用缺数据，整轮不给 tokens/s", () => {
    expect(aggregateTurnOutputRate([call(), call({ timeToFirstContentMs: undefined })])).toBeNull();
  });

  it("没有任何调用（如外部引擎）时不给 tokens/s", () => {
    expect(aggregateTurnOutputRate([])).toBeNull();
  });
});
