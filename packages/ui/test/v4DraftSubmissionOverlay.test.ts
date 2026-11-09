import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildDraftSubmissionOverlayRows,
  isDraftSubmissionOverlaySettled,
  mergeDraftSubmissionOverlayRows,
  type DraftSubmissionOverlay,
} from "@/v4/draftSubmissionOverlay.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

// docs/desktop/engine-performance-1.1-spec.md「草稿首发的即时会话布局」：overlay 只是 Renderer 的
// pending optimistic overlay；以 sendText commandId == 真实行 sourceCommandId 去重。

const pending: DraftSubmissionOverlay = {
  localId: "local-1",
  text: "你好",
  startedAt: 1_700_000_000_000,
  commandId: null,
  boundSessionId: null,
  status: "pending",
};

function realRows(commandId: string): ConversationRow[] {
  return [
    {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1_700_000_000_500,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      sourceCommandId: commandId,
      state: "running",
      startedAt: 1_700_000_000_500,
    },
    {
      rowId: 2,
      turnId: "turn-1",
      createdAt: 1_700_000_000_500,
      createdAtSeq: 2,
      kind: "userInput",
      origin: "realUser",
      text: "你好",
      sourceCommandId: commandId,
    },
  ] as ConversationRow[];
}

describe("draftSubmissionOverlay", () => {
  it("pending overlay 渲染为用户气泡 + 运行中轮次，计时起点是点击时刻", () => {
    const rows = buildDraftSubmissionOverlayRows(pending);
    expect(rows.map((row) => row.kind)).toEqual(["turnHeader", "userInput"]);
    const [unit] = buildConversationTurnRenderUnits(rows, {
      nowMs: pending.startedAt + 3_000,
    });
    expect(unit?.isRunning).toBe(true);
    expect(unit?.visibleUserInputs.map((row) => row.text)).toEqual(["你好"]);
    expect(unit?.workSegments?.at(-1)?.workStatus).toEqual({ state: "running", durationMs: 3_000 });
  });

  it("失败 overlay 转为 failed 轮次并携带错误摘要，不再计时", () => {
    const rows = buildDraftSubmissionOverlayRows({
      ...pending,
      status: "failed",
      failure: { code: "SEND_FAILED", summary: "发送失败" },
    });
    const header = rows.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      state: "failed",
      failure: { code: "SEND_FAILED", summary: "发送失败", source: "runtime" },
    });
    const [unit] = buildConversationTurnRenderUnits(rows, { nowMs: pending.startedAt + 3_000 });
    expect(unit?.isRunning).toBe(false);
    expect(unit?.workStatus).toBeUndefined();
  });

  it("真实行未出现前追加在真实行之后；出现同一 sourceCommandId 后只保留真实行", () => {
    const withCommand = { ...pending, commandId: "cmd-1" };
    expect(mergeDraftSubmissionOverlayRows([], withCommand).map((row) => row.kind)).toEqual([
      "turnHeader",
      "userInput",
    ]);
    const real = realRows("cmd-1");
    expect(isDraftSubmissionOverlaySettled(real, withCommand)).toBe(true);
    expect(mergeDraftSubmissionOverlayRows(real, withCommand)).toBe(real);
    // 别的命令的行不能误收口当前 overlay。
    const other = realRows("cmd-other");
    expect(isDraftSubmissionOverlaySettled(other, withCommand)).toBe(false);
    expect(mergeDraftSubmissionOverlayRows(other, withCommand)).toHaveLength(4);
  });

  it("没有 commandId 的 overlay 不会被任何真实行收口；null overlay 原样返回", () => {
    const real = realRows("cmd-1");
    expect(isDraftSubmissionOverlaySettled(real, pending)).toBe(false);
    expect(mergeDraftSubmissionOverlayRows(real, null)).toBe(real);
  });

  it("overlay 行 id 排在任何真实行之后，不与真实 rowId 冲突", () => {
    const rows = buildDraftSubmissionOverlayRows(pending);
    for (const row of rows) expect(row.rowId).toBeGreaterThan(Number.MAX_SAFE_INTEGER - 10);
    expect(rows[0]!.rowId).toBeLessThan(rows[1]!.rowId);
  });
});
