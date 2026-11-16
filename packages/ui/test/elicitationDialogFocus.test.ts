// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeElicitationRequest } from "@zcode/shared";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-test-other-composer]").forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

describe("ElicitationDialog custom answer focus", () => {
  it("非焦点栏的问答不自动聚焦，激活后恢复键盘操作", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const otherComposer = document.createElement("textarea");
    otherComposer.dataset.testOtherComposer = "true";
    document.body.append(otherComposer);
    otherComposer.focus();
    const request: ZCodeElicitationRequest = {
      type: "elicitation_request",
      taskId: "background-task",
      traceId: "background-trace",
      requestId: "background-question",
      message: "请选择方案",
      options: [],
      questions: [{ question: "请选择方案", options: [{ value: "one", label: "方案一" }] }],
    };
    const content = (autoFocus: boolean) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ElicitationDialog, { request, autoFocus, onRespond: vi.fn() }),
      );
    const view = render(content(false));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(otherComposer);
    view.rerender(content(true));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.container.querySelector('[data-elicitation-dialog-card="true"]'),
      ),
    );
    otherComposer.remove();
  });

  it.each(["single", "multi", "plan"])(
    "%s: 上下键可进入及离开自定义输入框，保留草稿且不隐式提交",
    async (kind) => {
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
      );
      vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
      const request: ZCodeElicitationRequest = {
        type: "elicitation_request",
        taskId: "task-focus",
        traceId: "trace-focus",
        requestId: "ask-focus",
        message: "请选择方案",
        options: [],
        questions: [
          {
            question: "请选择方案",
            multiSelect: kind === "multi",
            options: [
              { value: "approve", label: "方案一" },
              { value: "second", label: "方案二" },
            ],
          },
        ],
        ...(kind === "plan"
          ? { schema: { interaction: "plan_approval", toolName: "ExitPlanMode" } }
          : {}),
      };
      const onRespond = vi.fn();
      const { container } = render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ElicitationDialog, { request, onRespond }),
        ),
      );
      const options = container.querySelectorAll<HTMLButtonElement>(
        'button[role="option"],button[role="checkbox"]',
      );
      const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
      const card = container.querySelector<HTMLElement>('[data-elicitation-dialog-card="true"]')!;
      await waitFor(() => expect(document.activeElement).toBe(kind === "plan" ? options[0] : card));

      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.change(input, { target: { value: "保留我的自定义答案\n第二行" } });

      // 输入法上下选词不能误切到选项；同时覆盖 native 和 composition ref 两种保护。
      fireEvent.keyDown(input, { key: "ArrowUp", isComposing: true });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.activeElement).toBe(input);
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.activeElement).toBe(input);
      fireEvent.compositionEnd(input);

      fireEvent.keyDown(input, { key: "ArrowUp" });
      await waitFor(() => expect(document.activeElement).toBe(options[1]));
      fireEvent.keyDown(options[1]!, { key: "ArrowDown" });
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await waitFor(() => expect(document.activeElement).toBe(options[0]));
      fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
      await waitFor(() => expect(document.activeElement).toBe(input));

      expect(input.value).toBe("保留我的自定义答案\n第二行");
      expect(onRespond).not.toHaveBeenCalled();
      expect(options[0]!.getAttribute(kind === "multi" ? "aria-checked" : "aria-selected")).toBe(
        "false",
      );
      if (kind !== "multi") {
        expect(input.previousElementSibling?.textContent).toBe("3.");
      }
    },
  );
});

function ordinaryRequest(): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-explicit",
    traceId: "trace-explicit",
    requestId: "ask-explicit",
    message: "第一题",
    options: [],
    questions: [
      {
        question: "第一题",
        options: [
          { value: "first", label: "选项一" },
          { value: "changed", label: "改选" },
        ],
      },
      { question: "第二题", options: [{ value: "second", label: "选项二" }] },
    ],
  };
}

function renderOrdinary(request = ordinaryRequest()) {
  const onRespond = vi.fn();
  const onFirstInteraction = vi.fn(() => true);
  const content = (nextRequest: ZCodeElicitationRequest) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ElicitationDialog, {
        request: nextRequest,
        autoFocus: false,
        onRespond,
        onFirstInteraction,
      }),
    );
  const view = render(content(request));
  return { ...view, onRespond, onFirstInteraction, content };
}

describe("普通 Ask 显式发送", () => {
  it("点选只改草稿，前后导航可回改，发送双击只响应一次", () => {
    const view = renderOrdinary();
    fireEvent.click(view.getByRole("option", { name: /选项一/ }));
    expect(view.getByText("第一题")).toBeTruthy();
    expect(view.onRespond).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "继续" }));
    fireEvent.click(view.getByRole("option", { name: /选项二/ }));
    expect(view.onRespond).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "上一题" }));
    fireEvent.click(view.getByRole("option", { name: /改选/ }));
    fireEvent.click(view.getByRole("button", { name: "继续" }));
    const send = view.getByRole("button", { name: "发送" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(view.onRespond).toHaveBeenCalledExactlyOnceWith("ask-explicit", "accept", {
      answers: { 第一题: "changed", 第二题: "second" },
      answer_0: "changed",
      answer_1: "second",
    });
    expect(view.onFirstInteraction).toHaveBeenCalledTimes(1);
  });

  it("方向键只导航，数字/Enter选择仍等待发送；下一题不补选焦点答案", () => {
    const view = renderOrdinary();
    const card = view.container.querySelector('[data-elicitation-dialog-card="true"]')!;
    fireEvent.keyDown(card, { key: "ArrowDown" });
    fireEvent.click(view.getByRole("button", { name: "继续" }));
    fireEvent.keyDown(card, { key: "1" });
    const option = view.getByRole("option", { name: /选项二/ });
    expect(option.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(option, { key: "Enter" });
    expect(view.onRespond).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "发送" }));
    expect(view.onRespond).toHaveBeenCalledExactlyOnceWith("ask-explicit", "accept", {
      answers: { 第二题: "second" },
      answer_1: "second",
    });
  });

  it("多行输入与 IME Enter 不切题、不提交，关闭后原题草稿可重开", () => {
    const view = renderOrdinary();
    const input = view.container.querySelector("textarea")!;
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    expect(view.getByText("第一题")).toBeTruthy();
    expect(view.onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.getByText("等待回答")).toBeTruthy();
    expect(
      view.container.querySelector('[data-elicitation-dialog-body="true"]')?.className,
    ).toContain("hidden");
    view.rerender(
      view.content({ ...ordinaryRequest(), questions: [...ordinaryRequest().questions!] }),
    );
    fireEvent.click(view.getByRole("button", { name: "展开问题弹窗" }));
    expect(view.container.querySelector("textarea")?.value).toBe("第一行\n第二行");
    expect(view.onRespond).not.toHaveBeenCalled();
  });

  it.each(["taskId", "traceId"] as const)("相同 requestId 的 %s 换代不能继承草稿", (field) => {
    const request = ordinaryRequest();
    const view = renderOrdinary(request);
    fireEvent.click(view.getByRole("option", { name: /选项一/ }));
    view.rerender(view.content({ ...request, [field]: "new-identity" }));
    expect(view.getByRole("option", { name: /选项一/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("卡片本身 Enter 不能提交；跳过仍明确 decline", () => {
    const view = renderOrdinary();
    const card = view.container.querySelector('[data-elicitation-dialog-card="true"]')!;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(view.onRespond).not.toHaveBeenCalled();
    expect(view.getByText("第一题")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "忽略" }));
    expect(view.onRespond).toHaveBeenCalledExactlyOnceWith("ask-explicit", "decline");
  });
});

it.each(["button", "escape"])("普通 Ask %s 收起/重开只暂停一次且不回答", (method) => {
  const view = renderOrdinary();
  if (method === "button") fireEvent.click(view.getByRole("button", { name: "折叠问题弹窗" }));
  else
    fireEvent.keyDown(view.container.querySelector('[data-elicitation-dialog-card="true"]')!, {
      key: "Escape",
    });
  expect(view.onFirstInteraction).toHaveBeenCalledExactlyOnceWith("navigation");
  expect(view.onRespond).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "展开问题弹窗" }));
  expect(view.onFirstInteraction).toHaveBeenCalledTimes(1);
  expect(view.onRespond).not.toHaveBeenCalled();
});

it.each(["waiting", "expand"])("收起态 %s 入口的键盘冒泡不能改写隐藏答案", (entry) => {
  const view = renderOrdinary();
  fireEvent.click(view.getByRole("option", { name: /改选/ }));
  fireEvent.click(view.getByRole("button", { name: "折叠问题弹窗" }));
  const reopen =
    entry === "waiting"
      ? view.container.querySelector<HTMLButtonElement>(
          '[data-elicitation-waiting="true"] > button',
        )!
      : view.getByRole("button", { name: "展开问题弹窗" });
  reopen.focus();
  expect(fireEvent.keyDown(reopen, { key: "1" })).toBe(true);
  expect(fireEvent.keyDown(reopen, { key: "ArrowDown" })).toBe(true);
  expect(fireEvent.keyDown(reopen, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(reopen, { key: "Enter" })).toBe(true);
  expect(fireEvent.keyDown(reopen, { key: " " })).toBe(true);
  expect(document.activeElement).toBe(reopen);
  // jsdom 不执行按钮原生键盘激活；此处点击重开，真实 Enter/Space 路径由 Electron E2E 验证。
  fireEvent.click(reopen);
  expect(view.getByRole("option", { name: /改选/ }).getAttribute("aria-selected")).toBe("true");
  expect(view.getByRole("option", { name: /选项一/ }).getAttribute("aria-selected")).toBe("false");
  expect(view.onRespond).not.toHaveBeenCalled();
});

it("计划审批选项和 Escape 保留原确认/拒绝路径", () => {
  const request = {
    ...ordinaryRequest(),
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
    questions: [ordinaryRequest().questions![0]!],
  };
  const view = renderOrdinary(request);
  fireEvent.click(view.getByRole("option", { name: /选项一/ }));
  expect(view.onRespond).toHaveBeenCalledExactlyOnceWith("ask-explicit", "accept", {
    answers: { 第一题: "first" },
    answer_0: "first",
    answer: "first",
  });
  view.rerender(view.content({ ...request, requestId: "plan-escape" }));
  fireEvent.keyDown(view.container.querySelector('[data-elicitation-dialog-card="true"]')!, {
    key: "Escape",
  });
  expect(view.onRespond).toHaveBeenLastCalledWith("plan-escape", "decline");
});

it.each([false, true])(
  "isPlanApproval=%s 兼容 Promise<void> 回调且完成前后均防重",
  async (isPlanApproval) => {
    let finish!: () => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const request = {
      ...ordinaryRequest(),
      questions: [ordinaryRequest().questions![0]!],
      ...(isPlanApproval
        ? { schema: { interaction: "plan_approval", toolName: "ExitPlanMode" } }
        : {}),
    };
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ElicitationDialog, { request, onRespond, autoFocus: false }),
      ),
    );
    const activate = () =>
      fireEvent.click(
        isPlanApproval
          ? view.getByRole("option", { name: /选项一/ })
          : view.getByRole("button", { name: "发送" }),
      );
    activate();
    activate();
    expect(onRespond).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    activate();
    expect(onRespond).toHaveBeenCalledTimes(1);
  },
);
