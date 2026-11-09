// SAT31（docs/desktop/multi-agent-display-spec.md「对话行内 Subagent 工作卡 · 折叠」）：
// 父轮结束后仍有运行中成员的工作卡不进入完成轮次的「已工作 N 秒」折叠；全部结束后照常折叠。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  SubagentRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/v4/ConversationRowView.js", async () => {
  const React = await import("react");
  return {
    ConversationAssistantTextActions: () => React.createElement("div"),
    ConversationRowView: (props: { row: ConversationRow }) =>
      React.createElement("div", { "data-testid": `row-${props.row.rowId}` }),
  };
});

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "parent",
  theme: "system",
  workspacePath: "/workspace",
  onOpenSubagentSession: vi.fn(),
};

const START = 1_700_000_000_000;
const base = { turnId: "turn-1", createdAt: START };

function header(): TurnHeaderRow {
  return {
    ...base,
    rowId: 1,
    createdAtSeq: 0,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "completed",
    startedAt: START,
    endedAt: START + 12_000,
  } as TurnHeaderRow;
}

function userInput(): UserInputRow {
  return {
    ...base,
    rowId: 2,
    createdAtSeq: 1,
    kind: "userInput",
    origin: "realUser",
    text: "派两个后台子智能体",
  } as UserInputRow;
}

function readFile(rowId: number): ToolCallRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `read-${rowId}`,
    toolName: "Read",
    status: "success",
    input: { file_path: "/workspace/a.ts" },
    inputText: "",
  } as ToolCallRow;
}

function agentCall(rowId: number, description: string): ToolCallRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Agent",
    status: "success",
    input: {
      description,
      subagent_type: "explorer",
      prompt: "go",
      run_in_background: true,
    },
    inputText: "",
  } as ToolCallRow;
}

function subagent(
  rowId: number,
  parent: ToolCallRow,
  childSessionId: string,
  status: SubagentRow["status"],
): SubagentRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    parentToolCallId: parent.toolCallId,
    subagentType: "explorer",
    status,
    summaryText: "",
    childSessionId,
    startedAt: START + 1_000,
    ...(status === "running" ? {} : { endedAt: START + 30_000 }),
  } as SubagentRow;
}

function assistantText(rowId: number): AssistantTextRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: "已在后台派出子智能体",
    state: "completed",
  } as AssistantTextRow;
}

function render(rows: ConversationRow[]): string {
  const unit = buildConversationTurnRenderUnits(rows, {
    sessionPhase: "idle",
  })[0]!;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(ConversationTurnGroup, { unit, context }),
    }),
  );
}

function turnRows(statusB: SubagentRow["status"]): ConversationRow[] {
  const a = agentCall(4, "核对接口");
  const b = agentCall(5, "复核修复");
  return [
    header(),
    userInput(),
    readFile(3),
    a,
    b,
    subagent(6, a, "child-a", "success"),
    subagent(7, b, "child-b", statusB),
    assistantText(8),
  ];
}

describe("完成轮次折叠与运行中的 Subagent 工作卡（SAT31）", () => {
  it("父轮已结束、仍有运行中成员：工作卡显示在折叠摘要之下，其余工作项仍折叠", () => {
    const html = render(turnRows("running"));
    // 轮次已完成：「已工作…」折叠摘要存在且默认收起。
    expect(html).toContain('data-testid="chat-assistant-history-trigger-');
    expect(html).toContain('data-history-open="false"');
    // 工作卡不被折叠：成员行与运行中状态可见。
    expect(html).toContain('data-testid="v4-subagent-work-card-4"');
    expect(html).toContain('data-testid="v4-subagent-open-side-pane-child-b"');
    expect(html).toContain('data-state="running"');
    // 其它工作项（Read）仍在折叠内，不随工作卡一起露出。
    expect(html).not.toContain('data-testid="row-3"');
  });

  it("全部成员结束后工作卡随完成轮次正常折叠", () => {
    const html = render(turnRows("success"));
    expect(html).toContain('data-history-open="false"');
    expect(html).not.toContain('data-testid="v4-subagent-work-card-4"');
  });
});
