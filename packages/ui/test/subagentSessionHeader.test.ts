// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";

const harness = vi.hoisted(() => ({
  snapshots: new Map<string, unknown>(),
  acquired: [] as string[],
  released: [] as string[],
  sent: [] as Array<{ type: string; payload: unknown; sessionId?: string }>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values ? `${id}(${Object.values(values).join("/")})` : id,
    },
  }),
}));

// 真实 provider 的 layer / sendCommand 引用稳定；mock 也必须稳定，否则 lease effect 会每次渲染重订阅。
const conversation = vi.hoisted(() => {
  const states = new Map<string, { snapshot: unknown }>();
  return {
    layer: {
      acquire: (sessionId: string) => {
        harness.acquired.push(sessionId);
        return {
          store: {
            subscribe: () => () => {},
            getState: () => {
              const snapshot = harness.snapshots.get(sessionId) ?? null;
              const cached = states.get(sessionId);
              if (cached?.snapshot === snapshot) return cached;
              const next = { snapshot };
              states.set(sessionId, next);
              return next;
            },
          },
          release: () => harness.released.push(sessionId),
        };
      },
    },
    sendCommand: async (envelope: { type: string; payload: unknown; sessionId?: string }) => {
      harness.sent.push({
        type: envelope.type,
        payload: envelope.payload,
        sessionId: envelope.sessionId,
      });
      return { status: "accepted" };
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => conversation,
}));

afterEach(() => {
  cleanup();
  harness.snapshots.clear();
  harness.acquired = [];
  harness.released = [];
  harness.sent = [];
});

const tab = {
  id: "subagent-session:/repo:root:child-b",
  type: "subagent-session",
  workspaceKey: "/repo",
  workspacePath: "/repo",
  rootSessionId: "root",
  parentSessionId: "parent",
  childSessionId: "child-b",
  subagentType: "Explore",
  title: "Explore structure",
} satisfies SubagentSessionSidePaneTab;

async function renderHeader() {
  const { SubagentSessionHeader } = await import("@/subagent-display/index.js");
  return render(createElement(SubagentSessionHeader, { tab }));
}

describe("SubagentSessionHeader", () => {
  it("运行中：头像同序号同轮廓、名称、状态、实时耗时，可停时经父会话 cancelBackgroundWork 停止", async () => {
    harness.snapshots.set("parent", {
      subagents: {
        revision: 2,
        childSessionIds: ["child-a", "child-b"],
        running: [
          {
            childSessionId: "child-b",
            subagentType: "Explore",
            title: "Explore structure",
            status: "running",
            startedAt: Date.now() - 65_000,
          },
        ],
        endedTotal: 1,
      },
      backgroundWorks: [
        {
          workId: "work-b",
          kind: "subagent",
          title: "Explore structure",
          status: "running",
          startedAt: 0,
          anchorRowId: null,
          childSessionId: "child-b",
        },
      ],
    });
    const view = await renderHeader();
    const header = view.getByTestId("v4-subagent-session-header");
    expect(harness.acquired.sort()).toEqual(["child-b", "parent"]);
    expect(header.dataset.status).toBe("running");
    expect(header.textContent).toContain("Explore structure");
    expect(header.textContent).toContain("subagentDisplay.status.running");
    // 起点来自父会话 running.startedAt（65 秒前）；模块首次加载耗时会让秒数略增。
    expect(header.textContent).toMatch(/chat\.longRunning\.elapsedMinutesSeconds\(1\/\d+\)/u);
    const face = header.querySelector("svg[data-subagent-avatar]") as SVGElement;
    expect(face.getAttribute("data-face-variant")).toBe("antenna");
    expect(face.getAttribute("data-face-size")).toBe("24");
    expect(face.style.getPropertyValue("--wf-face-body")).toBe("#F19D38");

    await act(async () => view.getByTestId("v4-subagent-session-stop").click());
    expect(harness.sent).toEqual([
      { type: "cancelBackgroundWork", payload: { workId: "work-b" }, sessionId: "parent" },
    ]);
    view.unmount();
    expect(harness.released.sort()).toEqual(["child-b", "parent"]);
  });

  it("结束后读子会话终态与用时，不再提供停止", async () => {
    harness.snapshots.set("parent", {
      subagents: {
        revision: 3,
        childSessionIds: ["child-a", "child-b"],
        running: [],
        endedTotal: 2,
      },
      backgroundWorks: [],
    });
    harness.snapshots.set("child-b", {
      control: { phase: "completedSuccess", lastError: null },
      rows: {
        window: [{ kind: "turnHeader", rowId: 1, startedAt: 1_000, endedAt: 91_000 }],
        totalCount: 1,
        firstRowId: 1,
      },
    });
    const view = await renderHeader();
    const header = view.getByTestId("v4-subagent-session-header");
    expect(header.dataset.status).toBe("done");
    expect(header.textContent).toContain("subagentDisplay.status.done");
    expect(header.textContent).toContain(
      "subagentDisplay.header.took(1chat.summaryPanel.duration.minutes 30chat.summaryPanel.duration.seconds)",
    );
    expect(view.queryByTestId("v4-subagent-session-stop")).toBeNull();
    // 没有 model 时不显示模型标签（外部引擎、继承父模型）。
    expect(view.queryByTestId("v4-subagent-session-model")).toBeNull();
  });

  it("W8：运行中从父会话 running[] 显示模型与档位，结束后读父时间线的 subagent 行", async () => {
    harness.snapshots.set("parent", {
      subagents: {
        revision: 4,
        childSessionIds: ["child-b"],
        running: [
          {
            childSessionId: "child-b",
            subagentType: "Explore",
            title: "Explore structure",
            status: "running",
            startedAt: Date.now() - 5_000,
            model: "gpt-6.1-sol",
            effort: "high",
          },
        ],
        endedTotal: 0,
      },
      backgroundWorks: [],
    });
    const running = await renderHeader();
    expect(running.getByTestId("v4-subagent-session-model").textContent).toBe("gpt-6.1-sol high");
    running.unmount();

    harness.snapshots.set("parent", {
      subagents: { revision: 5, childSessionIds: ["child-b"], running: [], endedTotal: 1 },
      backgroundWorks: [],
      rows: {
        window: [
          {
            kind: "subagent",
            rowId: 9,
            subagentType: "Explore",
            status: "success",
            summaryText: "done",
            childSessionId: "child-b",
            model: "glm-5.3",
          },
        ],
        totalCount: 1,
        firstRowId: 9,
      },
    });
    const ended = await renderHeader();
    expect(ended.getByTestId("v4-subagent-session-model").textContent).toBe("glm-5.3");
  });
});
