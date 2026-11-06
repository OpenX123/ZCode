// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  TurnFailureRow,
  type TurnFailureRowProps,
} from "@/components/ai-elements/error-diagnostics.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: toastMock }));
afterEach(() => {
  cleanup();
  toastMock.mockReset();
});

function show(props: TurnFailureRowProps, locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(TurnFailureRow, props),
    }),
  );
}

const fields = {
  message: "unexpected status 502 Bad Gateway: Bad gateway",
  httpStatus: 502,
  url: "https://gateway.example.test/v1/responses",
  requestId: "fixture-request",
};

it("重试中显示“正在重新连接 n/m”，上限未知时显示次数，展开可见全部诊断", () => {
  show({ kind: "retry", attempt: 2, maxRetries: 5, fields });
  const row = screen.getByTestId("turn-failure-row");
  expect(row.textContent).toContain("正在重新连接 2/5");
  expect(row.textContent).toContain("HTTP 502");
  const details = row.querySelector("pre")?.textContent ?? "";
  expect(details).toContain("上游原文: unexpected status 502 Bad Gateway: Bad gateway");
  expect(details).toContain("HTTP 状态: 502");
  expect(details).toContain("URL: https://gateway.example.test/v1/responses");
  expect(details).toContain("请求 ID: fixture-request");
  cleanup();
  show({ kind: "retry", attempt: 3, maxRetries: 0, fields: {} }, "en-US");
  expect(screen.getByTestId("turn-failure-row").textContent).toContain("Reconnecting (attempt 3)");
});

it("终态失败显示摘要与诊断；仅提供重新发送时出现按钮，点击才发送且在途只发一次", async () => {
  const pending = Promise.withResolvers<void>();
  const onResend = vi.fn(() => pending.promise);
  show({ kind: "failure", summary: "网关返回 502", fields, onResend });
  const button = screen.getByRole("button", { name: "重新发送" });
  expect(onResend).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onResend).toHaveBeenCalledOnce();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve());
  expect((button as HTMLButtonElement).disabled).toBe(false);
  cleanup();
  show({ kind: "failure", summary: "网关返回 502", fields });
  expect(screen.queryByRole("button", { name: "重新发送" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("网关返回 502");
});

it("重新发送失败时提示且保留按钮", async () => {
  show({
    kind: "failure",
    summary: "网关返回 502",
    fields: {},
    onResend: vi.fn(async () => {
      throw new Error("blocked");
    }),
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新发送" })));
  expect(toastMock).toHaveBeenCalledWith("重新发送失败，请稍后重试");
  expect((screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
