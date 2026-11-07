// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
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

function subagent(rowId: number, parent: ToolCallRow, childSessionId: string): SubagentRow {
  return {
    rowId,
    turnId: parent.turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    parentToolCallId: parent.toolCallId,
    subagentType: "Explore",
    status: "running",
    summaryText: "",
    childSessionId,
  } as SubagentRow;
}

async function renderGroup(
  rows: Array<ToolCallRow | SubagentRow>,
  context: Partial<ConversationRowRenderContext>,
) {
  const { groupConsecutiveAgentSpawns, buildSubagentAvatarIndex, ConversationAgentSpawnRow } =
    await import("@/subagent-display/index.js");
  const items = groupConsecutiveAgentSpawns(
    buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning: true }),
  );
  const group = items[0]!;
  if (group.kind !== "agentSpawnGroup") throw new Error("expected a spawn group");
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
  it("一行展示所有名称与头像，有子会话时点击名称在右侧打开对应子会话", async () => {
    const onOpenSubagentSession = vi.fn();
    const first = agentCall(1, { turnId: "t1" });
    const second = agentCall(2, {
      turnId: "t1",
      input: { description: "检查", subagent_type: "code-reviewer" },
    });
    const view = await renderGroup(
      [
        first,
        second,
        subagent(3, first, "child-a"),
        { ...subagent(4, second, "child-b"), subagentType: "code-reviewer" },
      ],
      { onOpenSubagentSession },
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
    expect(
      faces.map((face) => (face as SVGElement).style.getPropertyValue("--wf-face-body")),
    ).toEqual(["#54B9A6", "#F19D38"]);

    act(() => view.getByTestId("v4-subagent-open-side-pane-child-b").click());
    expect(onOpenSubagentSession).toHaveBeenCalledWith({
      rootSessionId: "root",
      parentSessionId: "parent",
      childSessionId: "child-b",
      subagentType: "code-reviewer",
      title: "检查",
    });
    expect(row.dataset.open).toBe("false");
    expect(captured.cards).toEqual([]);
    expect(captured.presets).toEqual([]);
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

  it("展开后的已配对 Agent 卡以成员身份挂载，避免重复的直开 test id", async () => {
    const first = agentCall(21, { turnId: "t3" });
    const second = agentCall(22, { turnId: "t3" });
    const view = await renderGroup(
      [first, second, subagent(23, first, "child-a"), subagent(24, second, "child-b")],
      { onOpenSubagentSession: vi.fn() },
    );
    act(() => view.getByTestId("v4-subagent-spawn-toggle-21").click());
    expect(captured.cards.slice(0, 2)).toEqual([
      { toolCallId: "call-21", inSpawnGroup: true },
      { toolCallId: "call-22", inSpawnGroup: true },
    ]);
    expect(captured.cards.every((card) => card.inSpawnGroup)).toBe(true);
  });
});
