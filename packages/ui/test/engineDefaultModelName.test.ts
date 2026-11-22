import { describe, expect, it } from "vitest";
import { parseEngineDefaultModelName } from "@/external-engine/engineOptionDisplay.js";

// 形态来自本机 Claude adapter 0.95.0（session-model.js buildModelConfigOption）与
// SDK 0.3.309 supportedModels() 的实测输出，见 docs/desktop/external-agent-engines-spec.md。
describe("parseEngineDefaultModelName", () => {
  it.each([
    // adapter 匹配不到同 resolvedModel 的条目（SDK 大小写 [1m]/[1M] 不一致）时退化为 id。
    ["claude-opus-5-5[1m]", "Opus 5.5"],
    ["claude-opus-5-5[1M]", "Opus 5.5"],
    ["claude-fable-5-2", "Fable 5.2"],
    ["claude-sonnet-4-5-20250929", "Sonnet 4.5"],
    ["claude-opus-4-20250514", "Opus 4"],
    ["claude-opus-5", "Opus 5"],
    ["us.anthropic.claude-opus-5-5-v1:0", "Opus 5.5"],
    ["anthropic/claude-opus-5.5", "Opus 5.5"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
  ])("resolvedModel id %s → %s", (description, expected) => {
    expect(parseEngineDefaultModelName(description)).toBe(expected);
  });

  it.each([
    // SDK 原文：括号嵌套时旧正则只截到 `Opus 5.5 (1M context`。
    ["Use the default model (currently Opus 5.5 (1M context)) · $4/$20 per Mtok", "Opus 5.5"],
    ["Use the default model (currently Sonnet 4.6) · $3/$15 per Mtok", "Sonnet 4.6"],
    // SDK served 形态：`<模型名> · <说明>`。
    ["Opus 5.5 · Best for everyday, complex tasks", "Opus 5.5"],
    // adapter：对应条目的 displayName。
    ["Opus 5.5", "Opus 5.5"],
    ["Claude Sonnet 4.6", "Claude Sonnet 4.6"],
    ["Opus (1M context)", "Opus"],
    ["Opus 5.5 (1M context)", "Opus 5.5"],
  ])("SDK / displayName %s → %s", (description, expected) => {
    expect(parseEngineDefaultModelName(description)).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["   "],
    ["Uses the recommended model for your plan. Changes over time."],
    ["Use the default model (currently ) · $3/$15 per Mtok"],
    ["A very long description that is clearly a sentence and not a model name at all"],
  ])("无法可靠取名时返回 undefined：%s", (description) => {
    expect(parseEngineDefaultModelName(description)).toBeUndefined();
  });
});
