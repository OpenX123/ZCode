import { describe, expect, it } from "vitest";
import { usageStatsLocalZhCN, usageStatsLocalEnUS } from "./i18n.js";
import { usageStatsLocalUiModule } from "./module.js";

describe("usage-stats-local-ui contract", () => {
  it("declares its module manifest", () => {
    expect(usageStatsLocalUiModule.id).toBe("usage-stats-local-ui");
  });

  it("keeps zh-CN and en-US copy in sync under its own namespace", () => {
    expect(Object.keys(usageStatsLocalEnUS).sort()).toEqual(
      Object.keys(usageStatsLocalZhCN).sort(),
    );
    for (const key of Object.keys(usageStatsLocalZhCN)) {
      expect(key.startsWith("settings.usageStats.local.")).toBe(true);
    }
  });
});
