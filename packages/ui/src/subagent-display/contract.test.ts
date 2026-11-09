import { describe, expect, it } from "vitest";
import {
  subagentFaceExample,
  subagentSessionHeaderExample,
  subagentWorkLiveIndexExample,
} from "./contract.example.js";
import {
  buildSubagentAvatarIndex,
  buildSubagentWorkLiveIndex,
  resolveSubagentFaceVariant,
  sameSubagentWorkLiveIndex,
} from "./model.js";

describe("subagent-display 合同", () => {
  it("示例的序号与变体可由公开派生函数重现", () => {
    const index = buildSubagentAvatarIndex(["child-a", "child-b"]);
    expect(index.indexOf("child-b")).toBe(subagentFaceExample.avatarIndex);
    expect(resolveSubagentFaceVariant(subagentFaceExample.subagentType)).toBe(
      subagentSessionHeaderExample.variant,
    );
  });

  it("工作卡 live 索引只从父会话 running[] 与精确匹配的可停 work 派生", () => {
    const index = buildSubagentWorkLiveIndex(
      {
        revision: 1,
        childSessionIds: ["child-a", "child-b"],
        running: [
          { childSessionId: "child-b", subagentType: "Explore", title: "B", status: "waiting" },
        ],
        endedTotal: 1,
      },
      [
        {
          workId: "work-b",
          kind: "subagent",
          title: "B",
          status: "running",
          startedAt: 0,
          anchorRowId: null,
          childSessionId: "child-b",
        },
        {
          workId: "work-a",
          kind: "subagent",
          title: "A",
          status: "running",
          startedAt: 0,
          cancellable: false,
          anchorRowId: null,
          childSessionId: "child-a",
        },
      ],
    );
    expect(sameSubagentWorkLiveIndex(index, subagentWorkLiveIndexExample)).toBe(true);
  });
});
