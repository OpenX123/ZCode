import { describe, expect, it } from "vitest";
import { zcodeSessionRunningSubagentSchema } from "../src/zcode-protocol/index.js";
import { subagentRowSchema } from "../src/zcode-protocol-v4/rows.js";
import { runningSubagentSummarySchema } from "../src/zcode-protocol-v4/snapshot.js";

// W8 Subagent 工作卡：model / effort / toolCallCount 是只增不改的可选字段（docs/desktop/multi-agent-display-spec.md
// 「引擎无关合同」第 6 条）。旧 payload 必须继续通过，新字段必须严格校验。
const ROW_BASE = {
  rowId: 7,
  turnId: "turn-1",
  entityId: "agent-1",
  productTurnId: "turn-1",
  visibility: "visible",
  createdAt: 1,
  createdAtSeq: 1,
  kind: "subagent",
  subagentType: "Explore",
  status: "running",
  summaryText: "Inspect",
  childSessionId: "child-1",
} as const;

const RUNNING_BASE = {
  childSessionId: "child-1",
  subagentType: "Explore",
  title: "Inspect",
  status: "running",
} as const;

describe("W8 subagent work card protocol fields", () => {
  it("keeps legacy subagent rows and running items valid", () => {
    expect(subagentRowSchema.safeParse(ROW_BASE).success).toBe(true);
    expect(runningSubagentSummarySchema.safeParse(RUNNING_BASE).success).toBe(true);
    expect(zcodeSessionRunningSubagentSchema.safeParse(RUNNING_BASE).success).toBe(true);
  });

  it("accepts model, effort and toolCallCount on rows and running items", () => {
    const extra = { model: "gpt-6.1-sol", effort: "high", toolCallCount: 16 };
    expect(subagentRowSchema.parse({ ...ROW_BASE, ...extra })).toMatchObject(extra);
    expect(runningSubagentSummarySchema.parse({ ...RUNNING_BASE, ...extra })).toMatchObject(extra);
    expect(zcodeSessionRunningSubagentSchema.parse({ ...RUNNING_BASE, ...extra })).toMatchObject(
      extra,
    );
  });

  it.each([
    { model: "" },
    { effort: "  " },
    { toolCallCount: -1 },
    { toolCallCount: 1.5 },
    { toolCallCount: "3" },
  ])("rejects malformed field %o", (invalid) => {
    expect(subagentRowSchema.safeParse({ ...ROW_BASE, ...invalid }).success).toBe(false);
    expect(runningSubagentSummarySchema.safeParse({ ...RUNNING_BASE, ...invalid }).success).toBe(
      false,
    );
    expect(
      zcodeSessionRunningSubagentSchema.safeParse({ ...RUNNING_BASE, ...invalid }).success,
    ).toBe(false);
  });
});
