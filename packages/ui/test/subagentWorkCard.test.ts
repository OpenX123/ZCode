// @vitest-environment jsdom
// W8 Subagent 工作卡（docs/desktop/multi-agent-display-spec.md「对话行内 Subagent 工作卡」）。
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import zhCN from "@/i18n/locales/zh-CN.js";
import type { SubagentWorkLiveIndex } from "@/subagent-display/contract.js";
import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

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

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function agentCall(rowId: number, description: string, subagentType = "explorer"): ToolCallRow {
  return {
    rowId,
    turnId: "turn-w8",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Agent",
    status: "running",
    input: { description, subagent_type: subagentType, prompt: "go" },
    inputText: "",
  } as ToolCallRow;
}

function subagent(
  rowId: number,
  parent: ToolCallRow,
  childSessionId: string,
  overrides: Partial<SubagentRow> = {},
): SubagentRow {
  return {
    rowId,
    turnId: parent.turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    parentToolCallId: parent.toolCallId,
    subagentType: String((parent.input as { subagent_type: string }).subagent_type),
    status: "running",
    summaryText: "",
    childSessionId,
    ...overrides,
  } as SubagentRow;
}

async function renderCard(
  rows: Array<ToolCallRow | SubagentRow>,
  context: Partial<ConversationRowRenderContext> = {},
) {
  const { groupConsecutiveAgentSpawns, buildSubagentAvatarIndex, ConversationAgentSpawnRow } =
    await import("@/subagent-display/index.js");
  const items = groupConsecutiveAgentSpawns(
    buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning: true }),
  );
  const card = items[0]!;
  if (card.kind !== "agentSpawnGroup" || card.presentation !== "workCard") {
    throw new Error("expected a work card");
  }
  const fullContext = {
    workspacePath: "/repo",
    theme: "light",
    codePreviewSettings: {},
    sessionId: "parent",
    rootSessionId: "root",
    subagentAvatarIndex: buildSubagentAvatarIndex(["child-a", "child-b", "child-c"]),
    onOpenSubagentSession: vi.fn(),
    ...context,
  } as ConversationRowRenderContext;
  return render(createElement(ConversationAgentSpawnRow, { item: card, context: fullContext }));
}

const explorer = agentCall(1, "核对排班报错请求契约");
const reviewer = agentCall(2, "复核修复", "code-reviewer");
const tester = agentCall(3, "跑回归", "tester");

describe("SubagentWorkCard", () => {
  it("运行中：头部计数与耗时、主 Agent 节点、成员行的模型、状态、摘要与步骤数", async () => {
    const view = await renderCard([
      explorer,
      reviewer,
      subagent(4, explorer, "child-a", {
        model: "gpt-6.1-sol",
        effort: "high",
        toolCallCount: 16,
        startedAt: NOW - 58_000,
      }),
      subagent(5, reviewer, "child-b", {
        status: "success",
        toolCallCount: 9,
        startedAt: NOW - 60_000,
        endedAt: NOW - 28_000,
      }),
    ]);

    const card = view.getByTestId("v4-subagent-work-card-1");
    expect(card.dataset.state).toBe("running");
    expect(card.textContent).toContain("Subagent 正在工作");
    expect(card.textContent).toContain("2 个 Subagent · 已完成 1/2 · 1分");
    expect(card.textContent).toContain("主 Agent");
    expect(card.textContent).toContain("正在协调 2 个委派任务");

    const first = view.getByTestId("v4-subagent-open-side-pane-child-a");
    expect(first.tagName).toBe("BUTTON");
    expect(first.textContent).toContain("explorer");
    expect(first.textContent).toContain("gpt-6.1-sol high");
    expect(first.textContent).toContain("运行中 · 58秒");
    expect(first.textContent).toContain("核对排班报错请求契约");
    expect(first.textContent).toContain("16 个步骤");
    const second = view.getByTestId("v4-subagent-open-side-pane-child-b");
    expect(second.textContent).toContain("code-reviewer");
    expect(second.textContent).toContain("已完成 · 32秒");
    expect(second.textContent).toContain("9 个步骤");
    // 没有 model 的成员不显示模型标签。
    expect(second.querySelector("[data-subagent-model]")).toBeNull();
    // 头像：16px、颜色按清单序号、轮廓按类型。
    const faces = [...card.querySelectorAll("svg[data-subagent-avatar]")];
    expect(faces.map((face) => face.getAttribute("data-face-variant"))).toEqual([
      "antenna",
      "glasses",
    ]);
  });

  it("运行中的耗时每秒刷新，结束成员的耗时固定", async () => {
    const view = await renderCard([
      explorer,
      subagent(4, explorer, "child-a", { startedAt: NOW - 58_000 }),
    ]);
    const row = view.getByTestId("v4-subagent-open-side-pane-child-a");
    expect(row.textContent).toContain("58秒");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(row.textContent).toContain("59秒");
    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(row.textContent).toContain("1分 12秒");
  });

  it("点击成员行或按 Enter/Space 打开右侧只读子会话，传可见标题；不自动打开", async () => {
    const onOpenSubagentSession = vi.fn();
    const view = await renderCard(
      [explorer, subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 })],
      { onOpenSubagentSession },
    );
    expect(onOpenSubagentSession).not.toHaveBeenCalled();
    act(() => view.getByTestId("v4-subagent-open-side-pane-child-a").click());
    expect(onOpenSubagentSession).toHaveBeenCalledWith({
      rootSessionId: "root",
      parentSessionId: "parent",
      childSessionId: "child-a",
      subagentType: "explorer",
      title: "核对排班报错请求契约",
    });
  });

  it("停止全部只作用于可停的运行中成员；不可停成员没有停止按钮", async () => {
    const onCancelBackgroundWork = vi.fn();
    const onOpenSubagentSession = vi.fn();
    const live: SubagentWorkLiveIndex = new Map([
      ["child-a", { liveStatus: "running", cancellableWorkId: "work-a" }],
      ["child-b", { liveStatus: "waiting" }],
      ["child-c", { liveStatus: "running", cancellableWorkId: "work-c" }],
    ]);
    const view = await renderCard(
      [
        explorer,
        reviewer,
        tester,
        subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 }),
        subagent(5, reviewer, "child-b", { startedAt: NOW - 1_000 }),
        subagent(6, tester, "child-c", { startedAt: NOW - 1_000 }),
      ],
      { onCancelBackgroundWork, onOpenSubagentSession, subagentWorkLiveIndex: live },
    );

    // 父会话 running[] 的 waiting 覆盖行状态。
    expect(view.getByTestId("v4-subagent-open-side-pane-child-b").textContent).toContain(
      "等待确认",
    );
    expect(view.queryByTestId("v4-subagent-work-card-stop-child-b")).toBeNull();
    act(() => view.getByTestId("v4-subagent-work-card-stop-child-c").click());
    expect(onCancelBackgroundWork).toHaveBeenCalledWith("work-c");
    // 停止不冒泡到成员行。
    expect(onOpenSubagentSession).not.toHaveBeenCalled();

    onCancelBackgroundWork.mockClear();
    act(() => view.getByTestId("v4-subagent-work-card-stop-all-1").click());
    expect(onCancelBackgroundWork.mock.calls).toEqual([["work-a"], ["work-c"]]);
  });

  it("没有可停成员（Codex、前台）或只读会话时不显示停止与停止全部", async () => {
    const rows = [explorer, subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 })];
    const noWork = await renderCard(rows, {
      onCancelBackgroundWork: vi.fn(),
      subagentWorkLiveIndex: new Map([["child-a", { liveStatus: "running" }]]),
    });
    expect(noWork.queryByTestId("v4-subagent-work-card-stop-all-1")).toBeNull();
    expect(noWork.queryByTestId("v4-subagent-work-card-stop-child-a")).toBeNull();
    noWork.unmount();

    const readOnly = await renderCard(rows, {
      subagentWorkLiveIndex: new Map([
        ["child-a", { liveStatus: "running", cancellableWorkId: "work-a" }],
      ]),
    });
    expect(readOnly.queryByTestId("v4-subagent-work-card-stop-all-1")).toBeNull();
    expect(readOnly.queryByTestId("v4-subagent-work-card-stop-child-a")).toBeNull();
  });

  it("全部结束后折叠为摘要行，点击可展开回看；失败成员显示原因", async () => {
    const view = await renderCard([
      explorer,
      reviewer,
      subagent(4, explorer, "child-a", {
        status: "success",
        startedAt: NOW - 100_000,
        endedAt: NOW - 40_000,
      }),
      subagent(5, reviewer, "child-b", {
        status: "failed",
        summaryText: "provider 超时",
        startedAt: NOW - 90_000,
        endedAt: NOW - 28_000,
      }),
    ]);
    const card = view.getByTestId("v4-subagent-work-card-1");
    expect(card.dataset.state).toBe("ended");
    expect(card.textContent).toContain("2 个 Subagent 已完成 · 用时 1分 12秒 · 1 个失败");
    expect(view.queryByTestId("v4-subagent-open-side-pane-child-a")).toBeNull();
    expect(view.queryByTestId("v4-subagent-work-card-stop-all-1")).toBeNull();

    const toggle = view.getByTestId("v4-subagent-work-card-toggle-1");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    // 展开后折叠行换成头部的收起箭头（同一 test id）。
    expect(view.getByTestId("v4-subagent-work-card-toggle-1").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(card.textContent).toContain("已协调 2 个委派任务");
    expect(view.getByTestId("v4-subagent-open-side-pane-child-b").textContent).toContain(
      "provider 超时",
    );
  });

  it("尚未登记子会话的成员显示等待启动、不可打开", async () => {
    const view = await renderCard([
      explorer,
      reviewer,
      subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 }),
    ]);
    const pending = view.getByTestId("v4-subagent-work-card-member-call-2");
    expect(pending.textContent).toContain("等待启动");
    expect((pending as HTMLButtonElement).disabled).toBe(true);
  });
});
