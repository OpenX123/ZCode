// docs/desktop/engine-performance-1.1-spec.md「隐藏面板暂停渲染」HP04：
// 前台面板曾每个流式帧按全部行重建 4 张工作流联接表，表引用每帧变化又让 rowContext 与可见行跟着重渲染。
// 选择器只在工作流相关行（工具行、带 workflowLaunch 的轮首/用户行）引用变化时重建，结果与全量构建一致。
import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  buildWorkflowSaveCandidatesByRunId,
  createWorkflowRowTablesSelector,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";

const GRAPH = {
  steps: [{ id: "ask#1", kind: "ask", label: "a", lane: "actor#1", phase: "phase#1" }],
  lanes: [{ id: "actor#1" }],
  participants: [{ id: "p", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
  phases: [
    { id: "phase#1", name: "探索" },
    { id: "hole#1", name: "决定分组" },
  ],
  holes: [{ siteId: "hole#1", name: "决定分组", type: "Plan" }],
};

let seq = 0;
function base(turnId = "turn-1") {
  seq += 1;
  return { rowId: seq, turnId, createdAt: 1_700_000_000_000 + seq, createdAtSeq: seq };
}

function toolRow(options: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  ok?: boolean;
  fill?: { siteId: string; name: string };
}): ConversationRow {
  return {
    ...base(),
    kind: "toolCall",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    status: "success",
    inputText: "{}",
    input: options.input,
    ...(options.ok === undefined
      ? {}
      : {
          display: {
            kind: "create_workflow",
            ok: options.ok,
            errorCount: options.ok ? 0 : 1,
            diagnostics: [],
            causalityGraph: GRAPH,
            ...(options.fill ? { fill: options.fill } : {}),
          },
        }),
  } as unknown as ConversationRow;
}

function textRow(text: string): ConversationRow {
  return { ...base(), kind: "assistantText", text, state: "streaming" } as ConversationRow;
}

function fixtureRows(): ConversationRow[] {
  return [
    { ...base(), kind: "turnHeader", origin: "userInput", state: "running", startedAt: 1 },
    { ...base(), kind: "userInput", origin: "realUser", text: "做一个工作流" },
    toolRow({
      toolCallId: "tc-bad",
      toolName: "CreateWorkflow",
      input: { script: "x" },
      ok: false,
    }),
    toolRow({
      toolCallId: "tc-create",
      toolName: "CreateWorkflow",
      input: { script: "y" },
      ok: true,
    }),
    toolRow({
      toolCallId: "tc-fill",
      toolName: "FillWorkflowHole",
      input: { run_id: "run-1", hole_id: "hole#1", script: "z" },
      ok: true,
      fill: { siteId: "hole#1", name: "决定分组" },
    }),
    toolRow({
      toolCallId: "tc-save",
      toolName: "SaveWorkflow",
      input: { run_id: "run-1", name: "整理分组", scope: "project" },
    }),
    textRow("正在"),
  ] as ConversationRow[];
}

function fullBuild(rows: readonly ConversationRow[]) {
  return {
    graphByToolCallId: buildWorkflowGraphByToolCallId(rows),
    fillGraphByRunId: buildWorkflowFillGraphByRunId(rows),
    draftByToolCallId: buildWorkflowDraftByToolCallId(rows),
    saveCandidatesByRunId: buildWorkflowSaveCandidatesByRunId(rows),
  };
}

describe("createWorkflowRowTablesSelector", () => {
  it("HP04：结果与四张表的全量构建一致", () => {
    const rows = fixtureRows();
    const tables = createWorkflowRowTablesSelector()(rows);
    const expected = fullBuild(rows);
    expect(tables.graphByToolCallId).toEqual(expected.graphByToolCallId);
    expect(tables.fillGraphByRunId).toEqual(expected.fillGraphByRunId);
    expect(tables.draftByToolCallId).toEqual(expected.draftByToolCallId);
    expect(tables.saveCandidatesByRunId).toEqual(expected.saveCandidatesByRunId);
    // CreateWorkflow 两稿 + FillWorkflowHole 行都带 create_workflow 图。
    expect(tables.graphByToolCallId.size).toBe(3);
    expect(tables.saveCandidatesByRunId.get("run-1")).toEqual([
      { name: "整理分组", scope: "project" },
    ]);
  });

  it("HP04：流式帧只改正文行时复用上一份表（引用不变）", () => {
    const select = createWorkflowRowTablesSelector();
    const rows = fixtureRows();
    const first = select(rows);
    // 协议 apply 对未改动行保持引用：只替换末尾正文行，窗口数组是新的。
    const next = [...rows.slice(0, -1), textRow("正在生成第二段")];
    const second = select(next);
    expect(second).toBe(first);
    expect(second.graphByToolCallId).toBe(first.graphByToolCallId);
    expect(second.draftByToolCallId).toBe(first.draftByToolCallId);
    // 追加一条非工作流的正文行同样不重建。
    expect(select([...next, textRow("新段落")])).toBe(first);
  });

  it("HP04：工作流相关行变化时重建", () => {
    const select = createWorkflowRowTablesSelector();
    const rows = fixtureRows();
    const first = select(rows);
    const amended = [
      ...rows,
      toolRow({
        toolCallId: "tc-create-2",
        toolName: "CreateWorkflow",
        input: { script: "w" },
        ok: true,
      }),
    ];
    const second = select(amended);
    expect(second).not.toBe(first);
    expect(second.draftByToolCallId.get("tc-create")?.superseded).toBe(true);
    expect(second.draftByToolCallId).toEqual(fullBuild(amended).draftByToolCallId);
    expect(select(undefined).graphByToolCallId.size).toBe(0);
  });
});
