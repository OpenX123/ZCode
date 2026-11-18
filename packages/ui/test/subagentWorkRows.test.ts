// @vitest-environment jsdom
// 1.4 对话行内子智能体行（docs/desktop/multi-agent-display-spec.md「对话行内子智能体行」）。
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import zhCN from "@/i18n/locales/zh-CN.js";
import type { SubagentWorkLiveIndex } from "@/subagent-display/contract.js";
import { buildSubagentWorkCardModel, subagentTypeLabel } from "@/subagent-display/model.js";
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

// 冷启动时首个用例里的动态 import 需转译整条渲染链，常超过默认 5s 用例超时；
// 在假时钟启用前预热模块缓存，用例本身的断言不变。
beforeAll(async () => {
  await import("@/subagent-display/index.js");
}, 60_000);

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

async function renderRows(
  rows: Array<ToolCallRow | SubagentRow>,
  context: Partial<ConversationRowRenderContext> = {},
) {
  const { groupConsecutiveAgentSpawns, buildSubagentAvatarIndex, ConversationAgentSpawnRow } =
    await import("@/subagent-display/index.js");
  const items = groupConsecutiveAgentSpawns(
    buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning: true }),
  );
  const group = items[0]!;
  if (group.kind !== "agentSpawnGroup" || group.presentation !== "workCard") {
    throw new Error("expected subagent rows");
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
  return render(createElement(ConversationAgentSpawnRow, { item: group, context: fullContext }));
}

const explorer = agentCall(1, "核对排班报错请求契约");
const reviewer = agentCall(2, "复核修复", "code-reviewer");

describe("SubagentWorkRows", () => {
  it.each(["failed", "cancelled"] as const)(
    "%s 成员从父投影派生原因，空白和同名摘要不重复",
    (status) => {
      const input = {
        key: "result",
        toolCallId: "call-result",
        childSessionId: "child-result",
        title: "检查契约",
        subagentType: "explorer",
        status,
        avatarIndex: 0,
        fallbackName: "智能体 1",
      };
      const reasonOf = (summaryText: string) =>
        buildSubagentWorkCardModel([{ ...input, summaryText }], undefined).members[0]?.reason;
      expect(reasonOf(" provider 超时 ")).toBe("provider 超时");
      expect(reasonOf("检查契约")).toBeUndefined();
      expect(reasonOf(" \n ")).toBeUndefined();
    },
  );

  it("已完成成员不带原因", () => {
    const model = buildSubagentWorkCardModel(
      [
        {
          key: "done",
          toolCallId: "call-done",
          childSessionId: "child-done",
          title: "检查契约",
          subagentType: "explorer",
          status: "done",
          avatarIndex: 0,
          fallbackName: "智能体 1",
          summaryText: "核查通过",
        },
      ],
      undefined,
    );
    expect(model.members[0]?.reason).toBeUndefined();
    expect(model.active).toBe(false);
  });

  it.each([
    ["general-purpose", "Backend auth fix", "general-purpose"],
    ["subagent", "Backend auth fix", undefined],
    ["SubAgent", "Backend auth fix", undefined],
    ["  ", "Backend auth fix", undefined],
    ["Explore", "Explore", undefined],
  ])("类型 %s + 名称 %s → 类型标签 %s", (type, name, expected) => {
    expect(subagentTypeLabel(type, name)).toBe(expected);
  });

  it("连续派发渲染为连续行，不再有工作卡外框、标题、主 Agent 节点或折叠", async () => {
    const view = await renderRows([
      explorer,
      reviewer,
      subagent(4, explorer, "child-a", { startedAt: NOW - 58_000 }),
      subagent(5, reviewer, "child-b", {
        status: "success",
        startedAt: NOW - 60_000,
        endedAt: NOW,
      }),
    ]);
    const group = view.getByTestId("v4-subagent-work-card-1");
    expect(group.tagName).toBe("UL");
    expect(group.dataset.state).toBe("running");
    expect(group.className).not.toContain("border");
    expect(group.querySelectorAll("li")).toHaveLength(2);
    expect(group.textContent).not.toContain("Subagent 正在工作");
    expect(group.textContent).not.toContain("主 Agent");
    expect(view.queryByTestId("v4-subagent-work-card-toggle-1")).toBeNull();
    expect(view.queryByTestId("v4-subagent-work-card-stop-all-1")).toBeNull();
  });

  it("行：头像 + 名称 + 类型标签 + 运行中 · 用时；模型与步骤数不进入行", async () => {
    const view = await renderRows([
      explorer,
      reviewer,
      subagent(4, explorer, "child-a", {
        model: "gpt-6.1-sol",
        toolCallCount: 16,
        startedAt: NOW - 58_000,
      }),
      subagent(5, reviewer, "child-b", {
        status: "success",
        startedAt: NOW - 60_000,
        endedAt: NOW,
      }),
    ]);
    const first = view.getByTestId("v4-subagent-open-side-pane-child-a");
    expect(first.tagName).toBe("BUTTON");
    expect(first.querySelector("[title=核对排班报错请求契约]")?.textContent).toBe(
      "核对排班报错请求契约",
    );
    expect(first.querySelector("[data-subagent-type-label]")?.textContent).toBe("explorer");
    expect(first.textContent).toContain("运行中 · 58秒");
    expect(first.textContent).not.toContain("gpt-6.1-sol");
    expect(first.textContent).not.toContain("16 个步骤");
    const second = view.getByTestId("v4-subagent-open-side-pane-child-b");
    expect(second.textContent).toContain("已完成");
    expect(second.textContent).not.toContain("秒");
    const faces = [
      ...view.getByTestId("v4-subagent-work-card-1").querySelectorAll("svg[data-subagent-avatar]"),
    ];
    expect(faces.map((face) => face.getAttribute("data-face-variant"))).toEqual([
      "antenna",
      "glasses",
    ]);
  });

  it("默认类型 subagent 不显示类型标签", async () => {
    const call = agentCall(81, "Backend auth fix", "subagent");
    const view = await renderRows([call, subagent(82, call, "child-a")]);
    const row = view.getByTestId("v4-subagent-open-side-pane-child-a");
    expect(row.querySelector("[data-subagent-type-label]")).toBeNull();
    expect(row.textContent).toContain("Backend auth fix");
  });

  it("任务描述优先于 Explore 类型，类型只作为灰色标签", async () => {
    const call = agentCall(83, "排查文件预览空白", "Explore");
    const view = await renderRows([call, subagent(84, call, "child-a")]);
    const row = view.getByTestId("v4-subagent-open-side-pane-child-a");
    expect(row.querySelector("[title='排查文件预览空白']")?.textContent).toBe("排查文件预览空白");
    const label = row.querySelector("[data-subagent-type-label]");
    expect(label?.textContent).toBe("Explore");
    expect(label?.className).toContain("text-foreground-subtlest");
  });

  it("失败 / 已停止用一行灰字写原因", async () => {
    const a = agentCall(721, "失败检查");
    const b = agentCall(722, "停止检查");
    const view = await renderRows([
      a,
      b,
      subagent(724, a, "child-a", { status: "failed", summaryText: "权限不足" }),
      subagent(725, b, "child-b", { status: "cancelled", summaryText: "用户停止" }),
    ]);
    const failed = view.getByTestId("v4-subagent-open-side-pane-child-a");
    expect(failed.textContent).toContain("失败");
    const reason = failed.querySelector("[data-subagent-reason]");
    expect(reason?.textContent).toBe("原因：权限不足");
    expect(reason?.className).toContain("text-foreground-subtle");
    expect(reason?.className).not.toContain("destructive");
    const cancelled = view.getByTestId("v4-subagent-open-side-pane-child-b");
    expect(cancelled.textContent).toContain("已停止");
    expect(cancelled.querySelector("[data-subagent-reason]")?.textContent).toBe("原因：用户停止");
    expect(view.getByTestId("v4-subagent-work-card-721").dataset.state).toBe("ended");
  });

  it("运行中的用时每秒刷新；等待确认不显示用时", async () => {
    const view = await renderRows(
      [
        explorer,
        reviewer,
        subagent(4, explorer, "child-a", { startedAt: NOW - 58_000 }),
        subagent(5, reviewer, "child-b", { startedAt: NOW - 58_000 }),
      ],
      { subagentWorkLiveIndex: new Map([["child-b", { liveStatus: "waiting" }]]) },
    );
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
    const waiting = view.getByTestId("v4-subagent-open-side-pane-child-b");
    expect(waiting.textContent).toContain("等待确认");
    expect(waiting.textContent).not.toContain("秒");
  });

  it("点击行打开右侧子智能体详情，传可见标题；不自动打开", async () => {
    const onOpenSubagentSession = vi.fn();
    const view = await renderRows(
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

  it("可停成员行尾有停止，点击不冒泡到行；不可停成员没有停止", async () => {
    const onCancelBackgroundWork = vi.fn();
    const onOpenSubagentSession = vi.fn();
    const live: SubagentWorkLiveIndex = new Map([
      ["child-a", { liveStatus: "running", cancellableWorkId: "work-a" }],
      ["child-b", { liveStatus: "waiting" }],
    ]);
    const view = await renderRows(
      [
        explorer,
        reviewer,
        subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 }),
        subagent(5, reviewer, "child-b", { startedAt: NOW - 1_000 }),
      ],
      { onCancelBackgroundWork, onOpenSubagentSession, subagentWorkLiveIndex: live },
    );
    expect(view.queryByTestId("v4-subagent-work-card-stop-child-b")).toBeNull();
    const stop = view.getByTestId("v4-subagent-work-card-stop-child-a");
    expect(stop.getAttribute("aria-label")).toBe("停止 核对排班报错请求契约");
    act(() => stop.click());
    expect(onCancelBackgroundWork).toHaveBeenCalledWith("work-a");
    expect(onOpenSubagentSession).not.toHaveBeenCalled();
  });

  it("只读会话（未注入停止）不显示停止", async () => {
    const view = await renderRows(
      [explorer, subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 })],
      {
        subagentWorkLiveIndex: new Map([
          ["child-a", { liveStatus: "running", cancellableWorkId: "work-a" }],
        ]),
      },
    );
    expect(view.queryByTestId("v4-subagent-work-card-stop-child-a")).toBeNull();
  });

  it("尚未登记子会话的成员显示等待启动、不可打开", async () => {
    const view = await renderRows([
      explorer,
      reviewer,
      subagent(4, explorer, "child-a", { startedAt: NOW - 1_000 }),
    ]);
    const pending = view.getByTestId("v4-subagent-work-card-member-call-2");
    expect(pending.textContent).toContain("等待启动");
    expect((pending as HTMLButtonElement).disabled).toBe(true);
  });
});
