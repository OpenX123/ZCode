import { describe, expect, it } from "vitest";
import {
  localUsageRequestSchema,
  modelPriceSchema,
  setModelPriceOverrideRequestSchema,
} from "./contract.js";
import { usageStatsLocalProtocolModule } from "./module.js";

describe("usage-stats-local-protocol contract", () => {
  it("declares its module manifest", () => {
    expect(usageStatsLocalProtocolModule.id).toBe("usage-stats-local-protocol");
  });

  it("accepts the documented sources/ranges and rejects unknown fields", () => {
    expect(localUsageRequestSchema.parse({ source: "codex", range: "today" })).toEqual({
      source: "codex",
      range: "today",
    });
    expect(
      localUsageRequestSchema.safeParse({
        source: "all",
        range: "custom",
        customStartDate: "2026-11-01",
        customEndDate: "2026-11-30",
      }).success,
    ).toBe(true);
    expect(localUsageRequestSchema.safeParse({ source: "remote", range: "7d" }).success).toBe(
      false,
    );
    expect(
      localUsageRequestSchema.safeParse({
        source: "all",
        range: "custom",
        customStartDate: "11/01",
      }).success,
    ).toBe(false);
    expect(
      localUsageRequestSchema.safeParse({ source: "all", range: "7d", extra: 1 }).success,
    ).toBe(false);
  });

  it("requires non-negative prices; null override resets", () => {
    expect(
      modelPriceSchema.safeParse({ input: -1, output: 1, cacheRead: 0, cacheWrite: 0 }).success,
    ).toBe(false);
    expect(setModelPriceOverrideRequestSchema.parse({ modelId: "gpt-5", price: null })).toEqual({
      modelId: "gpt-5",
      price: null,
    });
  });
});
