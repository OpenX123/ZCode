// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NativePermissionOption } from "@zcode/shared/zcode-protocol-v4";
import { NativePlanApprovalCard, type NativePlanChoice } from "@/v4/NativePlanApprovalCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children: string }) => createElement("div", null, children),
}));
// Radix 菜单依赖指针事件与 portal；这里只验证选项内容与回传的原生 optionId。
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: unknown }) => createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: unknown }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: unknown }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: unknown;
    onSelect?: () => void;
  }) => createElement("button", { role: "menuitem", onClick: onSelect, ...props }, children),
}));
afterEach(cleanup);

// claude-agent-acp 0.95.0 的选项顺序；recommended/clearsContext 由 Runtime 标注。
const CLAUDE_OPTIONS: NativePermissionOption[] = [
  {
    optionId: "exit-plan-clear-auto",
    label: "Yes, clear context (12% used) and use auto mode",
    kind: "allow_always",
    clearsContext: true,
  },
  {
    optionId: "exit-plan-auto",
    label: "Yes, and use auto mode",
    kind: "allow_always",
    recommended: true,
  },
  { optionId: "exit-plan-default", label: "Yes, manually approve edits", kind: "allow_once" },
  { optionId: "reject", label: "No, keep planning", kind: "reject_once" },
];

function show(
  onResolve: (choice: NativePlanChoice) => Promise<boolean>,
  nativeOptions?: NativePermissionOption[],
) {
  return render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(NativePlanApprovalCard, {
        markdown: "# 原生计划",
        items: [{ id: "one", content: "检查连接", status: "pending" }],
        workspacePath: "/workspace",
        onResolve,
        ...(nativeOptions ? { nativeOptions } : {}),
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
  expect(onResolve).toHaveBeenCalledExactlyOnceWith({ start: true, optionId: undefined });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  await act(async () => response.resolve(true));
  expect((start as HTMLButtonElement).disabled).toBe(true);
});

it("修改只拒绝实施，回执失败保留计划并允许重试", async () => {
  const onResolve = vi.fn(async () => false);
  show(onResolve);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "继续修改" })));
  expect(onResolve).toHaveBeenCalledExactlyOnceWith({ start: false, optionId: undefined });
  expect(screen.getByRole("alert")).toBeDefined();
  expect(screen.getByText("# 原生计划")).toBeDefined();
  expect((screen.getByRole("button", { name: "开始执行" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("Claude 原生选项：主按钮回传推荐项，继续修改回传 reject，更多列出其余项并标注清空上下文", async () => {
  const onResolve = vi.fn(async () => false);
  show(onResolve, CLAUDE_OPTIONS);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始执行" })));
  expect(onResolve).toHaveBeenLastCalledWith({ start: true, optionId: "exit-plan-auto" });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "继续修改" })));
  expect(onResolve).toHaveBeenLastCalledWith({ start: false, optionId: "reject" });
  const items = screen.getAllByRole("menuitem");
  // 推荐项不重复出现在“更多”里，reject 也不在其中。
  expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
    "native-plan-option-exit-plan-clear-auto",
    "native-plan-option-exit-plan-default",
  ]);
  expect(items[0]?.textContent).toContain("Yes, clear context (12% used) and use auto mode");
  expect(items[0]?.textContent).toContain("清空上下文");
  expect(items[1]?.textContent).not.toContain("清空上下文");
  await act(async () => fireEvent.click(items[0]!));
  expect(onResolve).toHaveBeenLastCalledWith({ start: true, optionId: "exit-plan-clear-auto" });
});

it("未发审批请求的计划卡只提供开始执行，切出失败时保留计划并提示", async () => {
  const onStart = vi.fn(async () => false);
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(NativePlanApprovalCard, {
        markdown: "# 原生计划",
        items: [],
        workspacePath: "/workspace",
        onStart,
      }),
    }),
  );
  expect(screen.queryByRole("button", { name: "继续修改" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始执行" })));
  expect(onStart).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert").textContent).toContain("无法切出计划模式");
});
