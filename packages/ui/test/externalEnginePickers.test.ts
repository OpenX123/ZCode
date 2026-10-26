// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineConfigOption } from "@zcode/shared/external-engine";
import { EngineControls } from "@/external-engine/index.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);
const effort: EngineConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  currentValue: "medium-native",
  options: [
    { value: "low-native", name: "Low" },
    { value: "medium-native", name: "Medium" },
    { value: "high-native", name: "High" },
  ],
};
function tree(options: EngineConfigOption[], onConfigChange = vi.fn(), disabled = false) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(EngineControls, { engine: "codex", options, onConfigChange, disabled }),
  });
}

it("模型一次展开完整目录，未知当前值不隐式选模，选择回传原始值", () => {
  const onChange = vi.fn();
  const options = Array.from({ length: 18 }, (_, i) => ({
    value: `native-${i}`,
    name: `Model ${i}`,
  }));
  render(tree([{ id: "model", name: "Model", currentValue: "removed", options }], onChange));
  fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(18);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Model 17" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "native-17");
  expect(screen.queryByRole("menu")).toBeNull();
});

it("深度拖动仅预览，释放后提交一次；键盘也提交引擎原始档位", () => {
  const onChange = vi.fn();
  const view = render(tree([effort], onChange));
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  const slider = screen.getByRole("slider", { name: "Reasoning effort" });
  fireEvent.change(slider, { target: { value: "0" } });
  fireEvent.change(slider, { target: { value: "2" } });
  expect(screen.getByTestId("engine-effort-value").textContent).toBe("High");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("reasoning_effort", "high-native");
  view.rerender(tree([{ ...effort, currentValue: "high-native" }], onChange));
  fireEvent.change(slider, { target: { value: "0" } });
  fireEvent.keyUp(slider, { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith("reasoning_effort", "low-native");
  expect(onChange).toHaveBeenCalledTimes(2);
});

it("Escape 丢弃预览，模型切换后的目录不会沿用旧档位", () => {
  const onChange = vi.fn();
  const view = render(tree([effort], onChange));
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
  fireEvent.keyDown(screen.getByRole("slider"), { key: "Escape" });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Medium");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
  view.rerender(
    tree(
      [
        {
          ...effort,
          currentValue: "new-low",
          options: [
            { value: "new-low", name: "New low" },
            { value: "new-high", name: "New high" },
          ],
        },
      ],
      onChange,
    ),
  );
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("New low");
  expect(onChange).not.toHaveBeenCalled();
});

it("单档和禁用配置不提交；未知当前值可显式选择首档", () => {
  const onChange = vi.fn();
  const view = render(
    tree([{ ...effort, currentValue: "missing", options: effort.options.slice(0, 1) }], onChange),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  expect(screen.getByRole("slider").hasAttribute("disabled")).toBe(true);
  fireEvent.pointerUp(screen.getByRole("slider"));
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(tree([{ ...effort, currentValue: "missing" }], onChange));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerUp(screen.getByRole("slider"));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("reasoning_effort", "low-native");
  view.rerender(tree([effort], onChange, true));
  expect(screen.getByRole("button", { name: "Reasoning effort" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
  fireEvent.pointerUp(screen.getByRole("slider"));
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("恢复中和失败时保留配置但禁止修改，重新连接独立于发送", () => {
  const onConfigChange = vi.fn();
  const onRetry = vi.fn();
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        options: [effort],
        onConfigChange,
        loading: true,
      }),
    }),
  );
  expect(screen.getByRole("status").textContent).toContain("正在连接");
  expect(screen.getByRole("button", { name: "Reasoning effort" }).hasAttribute("disabled")).toBe(
    true,
  );
  view.rerender(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        options: [effort],
        onConfigChange,
        error: "恢复失败",
        onRetry,
      }),
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("恢复失败");
  expect(screen.getByRole("button", { name: "Reasoning effort" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(onConfigChange).not.toHaveBeenCalled();
});

it("恢复失败显示登录处理命令与安全诊断，重试仍沿现有回调", () => {
  const onRetry = vi.fn();
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        connectionFailure: { code: "authentication", method: "session/resume", rpcCode: -32000 },
        onRetry,
      }),
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("codex login");
  expect(screen.getByRole("alert").textContent).toContain("session/resume, RPC -32000");
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  expect(onRetry).toHaveBeenCalledOnce();
});
