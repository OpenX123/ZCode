// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TurnFailureRow,
  type TurnFailureRowProps,
} from "@/components/ai-elements/error-diagnostics.js";
import { classifyErrorExplanation } from "@/error-explanations/index.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: toastMock }));
afterEach(() => {
  cleanup();
  toastMock.mockReset();
  vi.unstubAllGlobals();
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
  code: "external_engine.provider",
  message: "unexpected status 502 Bad Gateway: Bad gateway",
  httpStatus: 502,
  url: "https://gateway.example.test/v1/responses",
  requestId: "fixture-request",
  traceId: "fixture-trace",
};

function openDetails() {
  const toggle = screen.getByTestId("error-details-toggle");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("error-diagnostics-card")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  return screen.getByTestId("error-diagnostics-card");
}

it("重试中显示“正在重新连接 n/m”，上限未知时显示次数，详情卡可见全部诊断", () => {
  show({ kind: "retry", attempt: 2, maxRetries: 5, fields });
  const row = screen.getByTestId("turn-failure-row");
  expect(row.textContent).toContain("正在重新连接 2/5");
  const card = openDetails().textContent ?? "";
  expect(card).toContain("错误码external_engine.provider");
  expect(card).toContain("HTTP 状态502");
  expect(card).toContain("请求 IDfixture-request");
  expect(card).toContain("Trace IDfixture-trace");
  expect(card).toContain("URLhttps://gateway.example.test/v1/responses");
  expect(card).toContain("原始报错unexpected status 502 Bad Gateway: Bad gateway");
  cleanup();
  show({ kind: "retry", attempt: 3, maxRetries: 0, fields: {} }, "en-US");
  expect(screen.getByTestId("turn-failure-row").textContent).toContain("Reconnecting (attempt 3)");
  expect(screen.queryByTestId("error-details-toggle")).toBeNull();
});

it("终态失败一行：图标 + 摘要 + 重试 + 详情；点击才发送且在途只发一次", async () => {
  const pending = Promise.withResolvers<void>();
  const onResend = vi.fn(() => pending.promise);
  show({ kind: "failure", summary: "网关返回 502", fields, onResend });
  const button = screen.getByRole("button", { name: "重试" });
  expect(onResend).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onResend).toHaveBeenCalledOnce();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve());
  expect((button as HTMLButtonElement).disabled).toBe(false);
  cleanup();
  show({ kind: "failure", summary: "网关返回 502", fields });
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("网关返回 502");
  // HTTP 状态不再常驻行内，进入诊断卡。
  expect(alert.textContent).not.toContain("HTTP 502");
});

it("重试失败时提示且保留按钮", async () => {
  show({
    kind: "failure",
    summary: "网关返回 502",
    fields: {},
    onResend: vi.fn(async () => {
      throw new Error("blocked");
    }),
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
  expect(toastMock).toHaveBeenCalledWith("重新发送失败，请稍后重试");
  expect((screen.getByRole("button", { name: "重试" }) as HTMLButtonElement).disabled).toBe(false);
});

it("常见错误归类为人话，原摘要与建议进入诊断卡；复制全部包含全部字段", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  show({
    kind: "failure",
    summary: "401 Unauthorized: invalid x-api-key",
    fields: { httpStatus: 401, requestId: "req-1" },
  });
  const alert = screen.getByRole("alert");
  expect(alert.getAttribute("data-explanation")).toBe("auth");
  expect(alert.textContent).toContain("鉴权失败（401）");
  const card = openDetails();
  expect(card.textContent).toContain("建议检查 API Key 是否正确");
  expect(card.textContent).toContain("原始报错401 Unauthorized: invalid x-api-key");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制全部" })));
  const copied = writeText.mock.calls[0]?.[0] ?? "";
  expect(copied).toContain("鉴权失败（401）");
  expect(copied).toContain("HTTP 状态: 401");
  expect(copied).toContain("请求 ID: req-1");
  expect(copied).toContain("原始报错: 401 Unauthorized: invalid x-api-key");
  expect(toastMock).toHaveBeenCalledWith("已复制完整报错信息");
});

it("摘要已按稳定错误码本地化时不被归类说明覆盖", () => {
  show({
    kind: "failure",
    summary: "当前任务由其他窗口执行",
    explain: false,
    fields: { httpStatus: 429 },
  });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("当前任务由其他窗口执行");
  expect(alert.getAttribute("data-explanation")).toBeNull();
});

it("英文界面同步提供归类说明", () => {
  show({ kind: "failure", summary: "Overloaded", fields: { httpStatus: 529 } }, "en-US");
  expect(screen.getByRole("alert").textContent).toContain("The model service is busy right now");
  expect(screen.getByRole("button", { name: "Details" })).toBeDefined();
});

describe("classifyErrorExplanation", () => {
  it.each([
    [{ httpStatus: 401 }, "auth"],
    [{ httpStatus: 403 }, "forbidden"],
    [{ httpStatus: 429 }, "rateLimit"],
    [{ httpStatus: 529 }, "overloaded"],
    [{ httpStatus: 503 }, "overloaded"],
    [{ httpStatus: 504 }, "timeout"],
    [{ message: '{"type":"overloaded_error","message":"Overloaded"}' }, "overloaded"],
    [{ message: "Rate limit reached for requests" }, "rateLimit"],
    [{ message: "Invalid API key provided" }, "auth"],
    [{ message: "Request timed out after 600s" }, "timeout"],
    [{ message: "fetch failed: ECONNRESET" }, "network"],
    [{ source: "network", message: "socket closed" }, "network"],
    [
      { httpStatus: 400, message: "prompt is too long: 210000 tokens > 200000 maximum" },
      "contextTooLong",
    ],
    [{ message: "This model's maximum context length is 128000 tokens" }, "contextTooLong"],
  ] as const)("%o → %s", (input, kind) => {
    expect(classifyErrorExplanation(input)).toBe(kind);
  });
  it.each([
    { httpStatus: 502, message: "Bad gateway" },
    { message: "Provider quota exceeded" },
    { message: "Current image attachments are too large to send." },
    {},
  ])("%o 不归类", (input) => {
    expect(classifyErrorExplanation(input)).toBeUndefined();
  });
});
