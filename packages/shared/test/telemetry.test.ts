import { describe, expect, it } from "vitest";
import { sanitizeTelemetrySkillName } from "../src/telemetry.js";

describe("运行时 Skill 名称隐私边界", () => {
  it.each(["pptx", "control-browser", "demo_skill", "a".repeat(64)])("保留合法标识 %s", (name) => {
    expect(sanitizeTelemetrySkillName(name)).toBe(name);
  });
  it.each([
    "/Users/FAKE_USER/private",
    "C:\\private\\key",
    "https://example.com/?token=FAKE",
    "demo\nFAKE_SECRET",
    " demo",
    "demo ",
    "document-skills:pptx",
    "user@example.com",
    "sk-" + "a".repeat(49),
    "ghp_" + "a".repeat(36),
    "AKIA" + "A".repeat(16),
    "a".repeat(65),
    "a".repeat(5000),
    "",
    123,
    null,
  ])("拒绝不受控名称 %#", (name) => {
    expect(sanitizeTelemetrySkillName(name)).toBe("unknown");
  });
});
