import { describe, expect, it } from "vitest";
import type { ToolCallRow, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { deriveLogicalUiInstances, createLogicalUiInstancesSelector } from "@/plugin-ui/index.js";

function row(id: number, status: ToolCallRow["status"] = "success", isError = false): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    turnId: "turn",
    createdAt: id,
    createdAtSeq: id,
    toolCallId: `call-${id}`,
    toolName: "mcp__fixture__edit",
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "fixture",
      toolName: "edit",
      ui: {
        pluginId: "fixture",
        resourceUri: "ui://fixture",
        surface: "panel",
        preferredDisplayMode: "fullscreen",
        showInline: true,
        ...(isError ? { isError: true } : {}),
      },
    },
  };
}

describe("插件裁决的增量缓存", () => {
  it("文本 token 复用插件裁决，新轮和插件结果变化仍按全窗推导", () => {
    const select = createLogicalUiInstancesSelector();
    const history = [row(1)];
    const text: ConversationRow = {
      kind: "assistantText",
      rowId: 2,
      turnId: "next",
      createdAt: 2,
      createdAtSeq: 2,
      state: "streaming",
      text: "初始",
    };
    const first = select([...history, text], { history, tail: [text] });
    const next = { ...text, text: "继续" };
    expect(select([...history, next], { history, tail: [next] })).toBe(first);
    const revised = { ...history[0]!, status: "error" as const };
    for (const partition of [
      { history: [revised], tail: [next] },
      { history, tail: [next, { ...next, rowId: 3, turnId: "third" }] },
      { history, tail: [next, { ...row(4), turnId: "next" }] },
    ]) {
      const rows = [...partition.history, ...partition.tail];
      expect(select(rows, partition)).toEqual(deriveLogicalUiInstances(rows));
    }
  });
});
