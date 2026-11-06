// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NativePlanApprovalCard } from "@/v4/NativePlanApprovalCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children: string }) => createElement("div", null, children),
}));
afterEach(cleanup);

function show(onResolve: (start: boolean) => Promise<boolean>) {
  return render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(NativePlanApprovalCard, {
        markdown: "# 原生计划",
        items: [{ id: "one", content: "检查连接", status: "pending" }],
        workspacePath: "/workspace",
        onResolve,
      }),
    }),
  );
}

it("pending清单是静态审批；开始按钮在ACK前不能重复实施", async () => {
  const response = Promise.withResolvers<boolean>();
  const onResolve = vi.fn(() => response.promise);
  show(onResolve);
  expect(screen.getByTestId("native-plan-checklist").textContent).toContain("检查连接");
  expect(screen.getByText("# 原生计划")).toBeDefined();
  const start = screen.getByRole("button", { name: "开始执行" });
  fireEvent.click(start);
  fireEvent.click(start);
  fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
  expect(onResolve).toHaveBeenCalledExactlyOnceWith(true);
  expect((start as HTMLButtonElement).disabled).toBe(true);
  await act(async () => response.resolve(true));
  expect((start as HTMLButtonElement).disabled).toBe(true);
});

it("修改只拒绝实施，回执失败保留计划并允许重试", async () => {
  const onResolve = vi.fn(async () => false);
  show(onResolve);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "继续修改" })));
  expect(onResolve).toHaveBeenCalledExactlyOnceWith(false);
  expect(screen.getByRole("alert")).toBeDefined();
  expect(screen.getByText("# 原生计划")).toBeDefined();
  expect((screen.getByRole("button", { name: "开始执行" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
