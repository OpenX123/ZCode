import { describe, expect, it } from "vitest";
import { subagentFaceExample, subagentSessionHeaderExample } from "./contract.example.js";
import { buildSubagentAvatarIndex, resolveSubagentFaceVariant } from "./model.js";

describe("subagent-display 合同", () => {
  it("示例的序号与变体可由公开派生函数重现", () => {
    const index = buildSubagentAvatarIndex(["child-a", "child-b"]);
    expect(index.indexOf("child-b")).toBe(subagentFaceExample.avatarIndex);
    expect(resolveSubagentFaceVariant(subagentFaceExample.subagentType)).toBe(
      subagentSessionHeaderExample.variant,
    );
  });
});
