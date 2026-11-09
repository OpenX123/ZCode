// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import zhCN from "@/i18n/locales/zh-CN.js";
import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const captured = vi.hoisted(() => ({
  presets: [] as string[],
  cards: [] as Array<{ toolCallId: string; inSpawnGroup: boolean }>,
  rows: [] as string[],
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        Object.entries(values ?? {}).reduce(
          (message, [key, value]) => message.replaceAll(`{${key}}`, value),
          (zhCN as Record<string, string>)[id] ?? id,
        ),
    },
  }),
}));

vi.mock("@/ToolCallBlocks/ToolLayout.js", () => ({
  presetToolLayoutOpen: (key: string) => captured.presets.push(key),
}));

// 逐个 Agent 卡沿用既有实现；这里只记录它们是否被挂载，以及是否以合并行成员身份挂载。
vi.mock("@/v4/ConversationAgentToolCallRow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/ConversationAgentToolCallRow.js")>();
  const React = await import("react");
  return {
    ...actual,
    ConversationAgentToolCallRow: (props: {
      item: { row: ToolCallRow };
      inSpawnGroup?: boolean;
    }) => {
      captured.cards.push({
        toolCallId: props.item.row.toolCallId,
        inSpawnGroup: props.inSpawnGroup === true,
      });
      return React.createElement("div", { "data-card": props.item.row.toolCallId });
    },
  };
});

vi.mock("@/v4/ConversationTurnRow.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnRow: ({ row }: { row: ToolCallRow }) => {
      captured.rows.push(row.toolCallId);
      return React.createElement("div", { "data-card": row.toolCallId });
    },
  };
});

afterEach(() => {
  cleanup();
  captured.presets = [];
  captured.cards = [];
  captured.rows = [];
});

function agentCall(rowId: number, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    rowId,
    turnId: "turn-x",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Agent",
    status: "running",
    input: { description: `任务 ${rowId}`, subagent_type: "Explore", prompt: "go" },
    inputText: "",
    ...overrides,
  } as ToolCallRow;
}

async function renderGroup(rows: ToolCallRow[], context: Partial<ConversationRowRenderContext>) {
  const { groupConsecutiveAgentSpawns, buildSubagentAvatarIndex, ConversationAgentSpawnRow } =
    await import("@/subagent-display/index.js");
  const items = groupConsecutiveAgentSpawns(
    buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning: true }),
  );
  const group = items[0]!;
  if (group.kind !== "agentSpawnGroup" || group.presentation !== "sentence") {
    throw new Error("expected a sentence spawn group");
  }
  const fullContext = {
    workspacePath: "/repo",
    theme: "light",
    codePreviewSettings: {},
    sessionId: "parent",
    rootSessionId: "root",
    subagentAvatarIndex: buildSubagentAvatarIndex(["child-a", "child-b"]),
    ...context,
  } as ConversationRowRenderContext;
  return render(createElement(ConversationAgentSpawnRow, { item: group, context: fullContext }));
}

describe("ConversationAgentSpawnRow", () => {
  it("都没有子会话时一行展示所有名称与头像（旧派发行兜底）", async () => {
    const view = await renderGroup(
      [
        agentCall(1, { turnId: "t1" }),
        agentCall(2, {
          turnId: "t1",
          input: { description: "检查", subagent_type: "code-reviewer" },
        }),
      ],
      { onOpenSubagentSession: vi.fn() },
    );

    const row = view.getByTestId("v4-subagent-spawn-group-1");
    // zh 列表格式："A和B"；整句 "{names} 开始工作"。
    expect(row.textContent).toContain("任务 1和检查 开始工作");
    expect(row.textContent).toContain("2 个运行中");
    const faces = [...row.querySelectorAll("svg[data-subagent-avatar]")];
    expect(faces.map((face) => face.getAttribute("data-face-variant"))).toEqual([
      "antenna",
      "glasses",
    ]);
    expect(row.dataset.open).toBe("false");
    expect(captured.cards).toEqual([]);
  });

  it("没有子会话时点击名称展开本行，并让该 Agent 卡展开行内详情", async () => {
    const onOpenSubagentSession = vi.fn();
    const view = await renderGroup(
      [
        agentCall(11, { turnId: "t2", activityText: "外部引擎输出" }),
        agentCall(12, { turnId: "t2", activityText: "外部引擎输出" }),
      ],
      { onOpenSubagentSession },
    );
    const row = view.getByTestId("v4-subagent-spawn-group-11");
    expect(row.dataset.open).toBe("false");

    act(() => view.getByTestId("v4-subagent-spawn-member-call-12").click());
    expect(onOpenSubagentSession).not.toHaveBeenCalled();
    expect(captured.presets).toEqual(["call-12"]);
    expect(row.dataset.open).toBe("true");
    expect([...new Set(captured.rows)]).toEqual(["call-11", "call-12"]);

    // 箭头按钮负责收起；不影响右侧面板。
    const toggle = view.getByTestId("v4-subagent-spawn-toggle-11");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle.click());
    expect(row.dataset.open).toBe("false");
  });
});
