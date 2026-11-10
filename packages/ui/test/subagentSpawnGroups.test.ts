import { describe, expect, it } from "vitest";
import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { groupConsecutiveAgentSpawns } from "@/subagent-display/spawnGroups.js";
import { describeAgentSpawnMember } from "@/subagent-display/spawnGroups.js";

function agentCall(rowId: number, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Agent",
    status: "running",
    input: { description: `Agent ${rowId}`, subagent_type: "Explore", prompt: "go" },
    inputText: "",
    ...overrides,
  } as ToolCallRow;
}

function subagent(rowId: number, parentRowId: number, childSessionId: string): SubagentRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    parentToolCallId: `call-${parentRowId}`,
    subagentType: "Explore",
    status: "running",
    summaryText: "",
    childSessionId,
  } as SubagentRow;
}

function text(rowId: number, turnId = "turn-1"): AssistantWorkRow {
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `read-${rowId}`,
    toolName: "Read",
    status: "success",
    input: { file_path: "/a" },
    inputText: "",
  } as AssistantWorkRow;
}

function build(rows: AssistantWorkRow[]) {
  return groupConsecutiveAgentSpawns(
    buildAssistantWorkRenderItems(
      rows,
      { messageStreamShowReasoning: true },
      {
        enableExploreGrouping: false,
        enableTerminalGrouping: false,
        enableCuaGrouping: false,
      },
    ),
  );
}

describe("派发分组（docs/desktop/multi-agent-display-spec.md「对话行内 Subagent 工作卡 · 分组」）", () => {
  it("同一轮相邻且任一成员已有子会话时合并为一张工作卡，身份锚定首个成员", () => {
    const items = build([
      agentCall(1),
      agentCall(2),
      agentCall(3, { toolName: "Task" }),
      subagent(4, 1, "child-1"),
      subagent(5, 2, "child-2"),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0]!;
    expect(group.kind).toBe("agentSpawnGroup");
    if (group.kind !== "agentSpawnGroup") return;
    expect(group.presentation).toBe("workCard");
    expect(group.key).toBe("subagentWorkCard:1");
    expect(group.members.map((member) => member.kind)).toEqual([
      "agentToolCall",
      "agentToolCall",
      "row",
    ]);
    expect(group.members.map(describeAgentSpawnMember)).toMatchObject([
      { title: "Agent 1", subagentType: "Explore", childSessionId: "child-1", status: "running" },
      { title: "Agent 2", childSessionId: "child-2" },
      { title: "Agent 3", status: "running" },
    ]);
    expect(describeAgentSpawnMember(group.members[2]!).childSessionId).toBeUndefined();
  });

  it("只合并相邻派发：中间夹其它可见工作项即断开；无子会话的单个派发保持原卡片", () => {
    const items = build([agentCall(1), text(2), agentCall(3), agentCall(4), text(5), agentCall(6)]);
    expect(items.map((item) => item.kind)).toEqual(["row", "row", "agentSpawnGroup", "row", "row"]);
    const group = items[2]!;
    expect(group.kind === "agentSpawnGroup" && group.members.length).toBe(2);
    // 都没有子会话：保持旧"A、B 和 C 开始工作"行。
    expect(group.kind === "agentSpawnGroup" && group.presentation).toBe("sentence");
    expect(group.key).toBe("agentSpawnGroup:3");
  });

  it("单个带子会话的派发也渲染为工作卡，并带出模型、档位、步骤数与起止时间", () => {
    const items = build([
      agentCall(1),
      {
        ...subagent(2, 1, "child-1"),
        model: "gpt-6.1-sol",
        effort: "high",
        toolCallCount: 16,
        startedAt: 1_000,
      },
    ]);
    expect(items).toHaveLength(1);
    const card = items[0]!;
    if (card.kind !== "agentSpawnGroup") throw new Error("expected work card");
    expect(card.presentation).toBe("workCard");
    expect(card.members).toHaveLength(1);
    expect(describeAgentSpawnMember(card.members[0]!)).toMatchObject({
      childSessionId: "child-1",
      model: "gpt-6.1-sol",
      effort: "high",
      toolCallCount: 16,
      startedAt: 1_000,
    });
  });

  it("组内任一成员登记子会话后整组切换为工作卡，未登记成员留在卡内", () => {
    const items = build([agentCall(1), agentCall(2), subagent(3, 2, "child-2")]);
    expect(items).toHaveLength(1);
    const card = items[0]!;
    expect(card.kind === "agentSpawnGroup" && card.presentation).toBe("workCard");
    expect(card.kind === "agentSpawnGroup" && card.members.length).toBe(2);
  });

  it("不同轮次的相邻派发不合并", () => {
    const items = build([agentCall(1), agentCall(2, { turnId: "turn-2" })]);
    expect(items.map((item) => item.kind)).toEqual(["row", "row"]);
  });

  it("流式追加成员时组 key 不变", () => {
    const first = build([agentCall(1), agentCall(2)]);
    const grown = build([agentCall(1), agentCall(2), agentCall(3)]);
    expect(first[0]!.key).toBe(grown[0]!.key);
  });
});
