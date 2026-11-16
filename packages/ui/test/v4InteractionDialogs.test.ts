// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ElicitationDialog } from "@/ElicitationDialog.js";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_USER_INPUT_DIALOG } from "@zcode/shared/test-ids";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { V4UserInputDialog } from "../src/v4/V4UserInputDialog.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import {
  buildV4ElicitationProgressKey,
  createInteractionAutoResolutionIntentTracker,
  getCurrentSessionInteractionSnapshot,
  resolveV4ElicitationRequest,
  V4InteractionDialogs,
} from "../src/v4/V4InteractionDialogs.js";

const captured = vi.hoisted(() => ({
  props: null as ComponentProps<typeof ElicitationDialog> | null,
  sendCommand: vi.fn(),
}));

vi.mock("@/ElicitationDialog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ElicitationDialog.js")>();
  return {
    ...actual,
    ElicitationDialog: (props: ComponentProps<typeof ElicitationDialog>) => {
      captured.props = props;
      return createElement(actual.ElicitationDialog, props);
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    sendCommand: captured.sendCommand,
  }),
}));

afterEach(() => {
  cleanup();
  useZCodeSessionStore.setState({ workspaces: {} });
  vi.clearAllMocks();
});

describe("V4InteractionDialogs", () => {
  it("通用用户输入停靠在所属会话，不绘制覆盖另一栏的全窗遮罩", () => {
    const html = renderToStaticMarkup(
      createElement(V4UserInputDialog, {
        model: { prompt: "需要输入", options: [], freeText: true, sensitive: false },
        onSubmit: vi.fn(),
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("需要输入");
    expect(html).not.toContain("fixed");
    expect(html).not.toContain("inset-0");
  });
  it("ignores a stale snapshot while switching back to another task", () => {
    const staleSnapshot = {
      sessionId: "task-b",
      pendingInteractions: [],
    } as ConversationSnapshot;

    expect(getCurrentSessionInteractionSnapshot("task-a", staleSnapshot)).toBeNull();
    expect(getCurrentSessionInteractionSnapshot("task-b", staleSnapshot)).toBe(staleSnapshot);
  });

  it("uses Bot question progress for the same v4 elicitation request", () => {
    const projected = {
      type: "elicitation_request" as const,
      taskId: "sess-1",
      traceId: "trace-1",
      requestId: "ask-1",
      message: "第一题",
      options: [],
      currentQuestionIndex: 0,
      questions: [],
    };
    const botProgress = {
      ...projected,
      message: "第二题",
      currentQuestionIndex: 1,
      answerDrafts: { answer_0: ["first-answer"] },
    };

    expect(resolveV4ElicitationRequest(projected, botProgress)).toBe(botProgress);
    expect(buildV4ElicitationProgressKey(botProgress)).toBe(
      '["sess-1","trace-1","ask-1"]:1:{"answer_0":["first-answer"]}',
    );
    expect(
      resolveV4ElicitationRequest(projected, {
        ...botProgress,
        requestId: "ask-other",
      }),
    ).toBe(projected);
  });

  it("remembers early user input and consumes the snooze intent exactly once", () => {
    const tracker = createInteractionAutoResolutionIntentTracker();

    tracker.markInteracted("ask-1");
    expect(tracker.consumeSnooze("ask-1", false)).toBe(false);
    expect(tracker.consumeSnooze("ask-1", true)).toBe(true);
    expect(tracker.consumeSnooze("ask-1", true)).toBe(false);
    tracker.releaseSnooze("ask-1");
    expect(tracker.consumeSnooze("ask-1", true)).toBe(true);
    expect(tracker.consumeSnooze("other", true)).toBe(false);
  });

  it("does not downgrade workspaceHookReview to a generic interaction dialog", () => {
    const snapshot = {
      sessionId: "sess-1",
      pendingInteractions: [
        {
          interactionId: "workspace-review-1",
          kind: "workspaceHookReview",
          anchorRowId: null,
          createdAt: 300,
          payload: {
            kind: "workspaceHookReview",
            reviewFlowId: "flow-1",
            generation: 1,
            interactionId: "workspace-review-1",
            sessionId: "sess-1",
            taskId: "sess-1",
            runId: "run-1",
            workspaceIdentity: "/workspace",
            workspaceLabel: "workspace",
            bundleDigest: "a".repeat(64),
            createdAt: 300,
            deadlineAt: 600_300,
            sourceFiles: [],
            summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
            items: [],
            warningCode: "workspace_hooks_execute_code",
          },
        },
      ],
    } as ConversationSnapshot;

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(html).toBe("");
  });

  it("renders the first generic interaction after a workspaceHookReview", () => {
    const snapshot = {
      sessionId: "sess-1",
      pendingInteractions: [
        {
          interactionId: "workspace-review-1",
          kind: "workspaceHookReview",
          anchorRowId: null,
          createdAt: 300,
          payload: {
            kind: "workspaceHookReview",
            reviewFlowId: "flow-1",
            generation: 1,
            interactionId: "workspace-review-1",
            sessionId: "sess-1",
            taskId: "sess-1",
            runId: "run-1",
            workspaceIdentity: "/workspace",
            workspaceLabel: "workspace",
            bundleDigest: "a".repeat(64),
            createdAt: 300,
            deadlineAt: 600_300,
            sourceFiles: [],
            summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
            items: [],
            warningCode: "workspace_hooks_execute_code",
          },
        },
        {
          interactionId: "plan-1",
          kind: "userInput",
          anchorRowId: 5,
          createdAt: 301,
          payload: {
            kind: "userInput",
            prompt: "请确认计划",
            freeText: true,
            toolName: "ExitPlanMode",
            toolCallId: "tool-plan",
            traceId: "trace-plan",
            schema: { toolName: "ExitPlanMode" },
            questions: [
              {
                question: "是否执行该计划？",
                header: "计划",
                options: [
                  { value: "approve", label: "执行", description: "执行当前计划" },
                  { value: "feedback", label: "反馈", description: "返回修改意见" },
                ],
              },
            ],
          },
        },
      ],
    } as ConversationSnapshot;

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(html).toContain("是否执行该计划？");
    expect(html).toContain("执行当前计划");
  });

  it("renders structured userInput interactions with ElicitationDialog", () => {
    const snapshot = {
      sessionId: "sess-1",
      pendingInteractions: [
        {
          interactionId: "ask-1",
          kind: "userInput",
          anchorRowId: 5,
          createdAt: 300,
          payload: {
            kind: "userInput",
            prompt: "请选择",
            freeText: true,
            toolName: "AskUserQuestion",
            toolCallId: "tool-ask",
            traceId: "trace-ask",
            schema: { toolName: "AskUserQuestion" },
            questions: [
              {
                question: "你想怎么做？",
                header: "方案",
                options: [
                  { value: "fast", label: "快速", description: "先做最小修复" },
                  { value: "safe", label: "稳妥", description: "补齐测试和文档" },
                ],
              },
            ],
          },
        },
      ],
    } as ConversationSnapshot;

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(html).toContain("你想怎么做？");
    expect(html).toContain("快速");
    expect(html).toContain("先做最小修复");
    expect(html).not.toContain(`data-testid="${TID_V4_USER_INPUT_DIALOG}"`);
  });
});

function askSnapshot(
  traceId = "trace-current",
  interactionId = "ask-current",
): ConversationSnapshot {
  return {
    sessionId: "session-current",
    pendingInteractions: [
      {
        interactionId,
        kind: "userInput",
        anchorRowId: null,
        createdAt: 1,
        payload: {
          kind: "userInput",
          prompt: "选择",
          freeText: true,
          toolName: "AskUserQuestion",
          traceId,
          toolCallId: "tool-current",
          questions: [{ question: "选择", options: [{ value: "yes", label: "是" }] }],
        },
      },
    ],
  } as ConversationSnapshot;
}

it.each([undefined, "remote-a"])(
  "remote=%s 同身份 snapshot/重挂保留，换 remote 后清空草稿和收起",
  (remoteSessionId) => {
    const content = (remote = remoteSessionId, snapshot = askSnapshot()) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          snapshot,
          sessionId: "session-current",
          workspacePath: "/same/path",
          remoteSessionId: remote,
          focused: false,
        }),
      );
    const first = render(content());
    fireEvent.click(first.getByRole("option", { name: /是/ }));
    fireEvent.click(first.getByRole("button", { name: "折叠问题弹窗" }));
    first.rerender(content(remoteSessionId, { ...askSnapshot() }));
    expect(first.getByText("等待回答")).toBeTruthy();
    first.unmount();
    const view = render(content());
    expect(view.getByText("等待回答")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "展开问题弹窗" }));
    expect(view.getByRole("option", { name: /是/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "折叠问题弹窗" }));
    view.rerender(content("remote-new"));
    expect(view.queryByText("等待回答")).toBeNull();
    expect(view.getByRole("option", { name: /是/ }).getAttribute("aria-selected")).toBe("false");
    view.rerender(content("remote-new", { ...askSnapshot(), pendingInteractions: [] }));
    const state = useZCodeSessionStore.getState();
    expect(
      state.getWorkspaceState("/same/path").taskUiByTaskId["session-current"]
        ?.elicitationFormDraftsByRequestId,
    ).toEqual({});
  },
);

it.each(["completed", "trace", "request", "session", "workspace", "remote"])(
  "%s 换代后的迟到 Ask 回答不得发出或答错后续请求",
  async (change) => {
    const snapshot = askSnapshot();
    const content = (
      snapshotValue: ConversationSnapshot,
      sessionId = "session-current",
      workspaceIdentity = "ssh-a",
      remoteSessionId = "remote-a",
    ) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          snapshot: snapshotValue,
          sessionId,
          workspacePath: "/same/path",
          workspaceIdentity,
          remoteSessionId,
          focused: false,
        }),
      );
    const view = render(content(snapshot));
    const oldRespond = captured.props!.onRespond;
    if (change === "completed") view.rerender(content({ ...snapshot, pendingInteractions: [] }));
    if (change === "trace") view.rerender(content(askSnapshot("trace-new")));
    if (change === "request") view.rerender(content(askSnapshot("trace-current", "ask-new")));
    if (change === "session")
      view.rerender(content({ ...snapshot, sessionId: "session-new" }, "session-new"));
    if (change === "workspace") view.rerender(content(snapshot, "session-current", "ssh-b"));
    if (change === "remote")
      view.rerender(content(snapshot, "session-current", "ssh-a", "remote-b"));
    await act(async () => {
      oldRespond("ask-current", "accept", { answers: { 选择: "yes" } });
    });
    expect(captured.sendCommand).not.toHaveBeenCalled();
  },
);

it("Bot 草稿只可覆盖同 session/trace/request 的 pending", () => {
  const projected = {
    type: "elicitation_request" as const,
    taskId: "session-a",
    traceId: "trace-a",
    requestId: "same",
    message: "问题",
    options: [],
  };
  expect(resolveV4ElicitationRequest(projected, { ...projected, traceId: "old-trace" })).toBe(
    projected,
  );
  expect(resolveV4ElicitationRequest(projected, { ...projected, taskId: "other-session" })).toBe(
    projected,
  );
});

it("问题卡所属组件卸载后，保留的旧回调不得重新发送", async () => {
  const view = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4InteractionDialogs, {
        snapshot: askSnapshot(),
        sessionId: "session-current",
        workspacePath: "/same/path",
        focused: false,
      }),
    ),
  );
  const oldRespond = captured.props!.onRespond;
  view.unmount();
  await act(async () => {
    oldRespond("ask-current", "accept", { answers: {} });
  });
  expect(captured.sendCommand).not.toHaveBeenCalled();
});

it("重复显式提交只发一个既有 resolveInteraction 命令", async () => {
  captured.sendCommand.mockImplementation(async (envelope) => ({
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  }));
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4InteractionDialogs, {
        snapshot: askSnapshot(),
        sessionId: "session-current",
        workspacePath: "/same/path",
        focused: false,
      }),
    ),
  );
  const respond = captured.props!.onRespond;
  await act(async () => {
    respond("ask-current", "accept", { answers: {} });
    respond("ask-current", "accept", { answers: {} });
  });
  expect(captured.sendCommand).toHaveBeenCalledTimes(1);
  expect(captured.sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "session-current",
      type: "resolveInteraction",
      payload: {
        interactionId: "ask-current",
        answer: { action: "accept", content: { answers: {} } },
      },
    }),
  );
});

it.each(["rejected", "transport"])("%s 后保留草稿可显式重试，成功后保持防重", async (failure) => {
  let finishFirst!: (ack: unknown) => void;
  let failFirst!: (error: Error) => void;
  captured.sendCommand
    .mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishFirst = resolve;
          failFirst = reject;
        }),
    )
    .mockImplementation(async (envelope) => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 1,
    }));
  const view = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4InteractionDialogs, {
        snapshot: askSnapshot(),
        sessionId: "session-current",
        workspacePath: "/same/path",
        focused: false,
      }),
    ),
  );
  fireEvent.click(view.getByRole("option", { name: /是/ }));
  const send = view.getByRole("button", { name: "发送" });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(captured.sendCommand).toHaveBeenCalledTimes(1);
  await act(async () => {
    if (failure === "transport") failFirst(new Error("isolated test transport failure"));
    else finishFirst({ status: "rejected", reasonCode: "test-rejected" });
  });
  expect(view.getByRole("option", { name: /是/ }).getAttribute("aria-selected")).toBe("true");
  await act(async () => {
    fireEvent.click(send);
  });
  expect(captured.sendCommand).toHaveBeenCalledTimes(2);
  expect(captured.sendCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      payload: {
        interactionId: "ask-current",
        answer: {
          action: "accept",
          content: {
            answers: { 选择: "yes" },
            answer_0: "yes",
            answer: "yes",
          },
        },
      },
    }),
  );
  fireEvent.click(send);
  expect(captured.sendCommand).toHaveBeenCalledTimes(2);
});

it("相同 requestId 的新 trace 首次交互仍独立暂停一次", async () => {
  captured.sendCommand.mockImplementation(async (envelope) => ({
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  }));
  const content = (traceId: string) => {
    const snapshot = askSnapshot(traceId);
    snapshot.pendingInteractions[0]!.autoResolution = {
      state: "hiddenGrace",
      startedAt: 1,
      visibleAt: 60001,
      deadlineAt: 300001,
    };
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4InteractionDialogs, {
        snapshot,
        sessionId: "session-current",
        workspacePath: "/same/path",
        focused: false,
      }),
    );
  };
  const view = render(content("trace-a"));
  await act(async () => {
    await captured.props!.onFirstInteraction!("answer");
  });
  view.rerender(content("trace-b"));
  expect(captured.sendCommand).toHaveBeenCalledTimes(1);
  await act(async () => {
    await captured.props!.onFirstInteraction!("navigation");
  });
  expect(captured.sendCommand).toHaveBeenCalledTimes(2);
});
