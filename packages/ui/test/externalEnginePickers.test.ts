// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { IExternalEngineService } from "@zcode/services";
import type {
  EngineConfigOption,
  ExternalEngineConnectionsView,
} from "@zcode/shared/external-engine";
import { EngineControls } from "@/external-engine/index.js";
import { useEngineConnectionControl } from "@/hooks/external-engine/index.js";
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

it("模型菜单沿用共享视口滚动约束，不覆盖可用高度", () => {
  const options = Array.from({ length: 18 }, (_, i) => ({
    value: `native-${i}`,
    name: `Model ${i}`,
  }));
  render(tree([{ id: "model", name: "Model", currentValue: options[0].value, options }]));
  fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
  const menu = screen.getByTestId("engine-config-menu-model");
  expect(menu.className).toContain("overflow-y-auto");
  expect(menu.className).not.toContain("max-h-none");
  expect(menu.className).not.toContain("overflow-visible");
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(18);
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
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  expect((slider as HTMLInputElement).value).toBe("2");
  // 引擎确认尚未回流时，其他 snapshot 更新也不能把已释放的滑块拉回旧值。
  view.rerender(tree([{ ...effort }], onChange));
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  view.rerender(tree([{ ...effort, currentValue: "high-native" }], onChange));
  fireEvent.change(slider, { target: { value: "0" } });
  fireEvent.keyUp(slider, { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith("reasoning_effort", "low-native");
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(slider.getAttribute("aria-valuetext")).toBe("Low");
  expect((slider as HTMLInputElement).value).toBe("0");
});

it("接受回包早于 snapshot 时仍保持所选位置，新确认值最终接管", async () => {
  const request = Promise.withResolvers<boolean>();
  const onChange = vi.fn(() => request.promise);
  const view = render(tree([effort], onChange));
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, { target: { value: "2" } });
  fireEvent.pointerUp(slider);
  await act(async () => request.resolve(true));
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  view.rerender(tree([{ ...effort, currentValue: "high-native" }], onChange));
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  view.rerender(tree([effort], onChange));
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  view.rerender(tree([{ ...effort, currentValue: "low-native" }], onChange));
  expect(slider.getAttribute("aria-valuetext")).toBe("Low");
  expect(onChange).toHaveBeenCalledOnce();
});

it.each(["failed", "rejected"])("配置 %s 后恢复确认值，不保留未生效的深度", async (kind) => {
  const request = Promise.withResolvers<boolean>();
  const onChange = vi.fn(() => request.promise);
  render(tree([effort], onChange));
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, { target: { value: "2" } });
  fireEvent.keyUp(slider, { key: "End" });
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  await act(async () => {
    if (kind === "failed") request.resolve(false);
    else request.reject(new Error("E2E_CONFIG_REJECTED"));
  });
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("reasoning_effort", "high-native");
});

it("较早提交的失败不清除后续手势，关闭后重新打开仍显示确认值", async () => {
  const request = Promise.withResolvers<boolean>();
  render(
    tree(
      [effort],
      vi.fn(() => request.promise),
    ),
  );
  const trigger = screen.getByRole("button", { name: "Reasoning effort" });
  fireEvent.click(trigger);
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, { target: { value: "2" } });
  fireEvent.pointerUp(slider);
  fireEvent.change(slider, { target: { value: "0" } });
  await act(async () => request.resolve(false));
  expect(slider.getAttribute("aria-valuetext")).toBe("Low");
  fireEvent.keyDown(slider, { key: "Escape" });
  fireEvent.click(trigger);
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Medium");
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

it("网关502显示服务错误、HTTP状态和可复制request id", () => {
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        connectionFailure: {
          code: "provider",
          method: "session/prompt",
          httpStatus: 502,
          message: "Bad Gateway",
          requestId: "fixture-request",
        },
      }),
    }),
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("模型请求失败");
  expect(alert.textContent).toContain("HTTP 502");
  expect(alert.textContent).toContain("Bad Gateway");
  expect(alert.textContent).toContain("fixture-request");
  expect(screen.getByRole("button", { name: "复制错误详情", hidden: true })).toBeDefined();
});

const choices = [
  { id: "official", name: "官方登录", description: "官方登录" },
  { id: "inherit", name: "沿用 CLI 配置", description: "沿用 CLI" },
  { id: "gateway-a", name: "公司网关", description: "API Key" },
];

it("草稿按引擎展示连接配置，一次展开完整列表并回传所选 ID", () => {
  const onSelectConnection = vi.fn();
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "claude-code",
        onSelectEngine: vi.fn(),
        connectionChoices: choices,
        connectionProfileId: "official",
        onSelectConnection,
      }),
    }),
  );
  const trigger = screen.getByTestId("engine-config-connection");
  expect(trigger.textContent).toContain("官方登录");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "官方登录" }));
  expect(onSelectConnection).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("engine-config-connection"), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("menuitemradio", { name: "公司网关" }));
  expect(onSelectConnection).toHaveBeenCalledExactlyOnceWith("gateway-a");
});

it("只有一个可选配置时不显示选择器；已创建会话只读显示绑定且不可改选", () => {
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        onSelectEngine: vi.fn(),
        connectionChoices: [choices[1]!],
        connectionProfileId: "inherit",
        onSelectConnection: vi.fn(),
      }),
    }),
  );
  expect(screen.queryByTestId("engine-config-connection")).toBeNull();
  view.rerender(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        connectionChoices: choices,
        connectionProfileId: "gateway-a",
        connectionLabel: "公司网关",
      }),
    }),
  );
  expect(screen.queryByTestId("engine-config-connection")).toBeNull();
  const label = screen.getByTestId("session-engine-connection");
  expect(label.textContent).toBe("公司网关");
  expect(label.getAttribute("title")).toContain("公司网关");
  expect(label.closest("button")).toBeNull();
});

it("草稿改选连接：Host 记录上次使用并重建预热，回流前显示所选值；已创建会话只读显示非缺省绑定", async () => {
  const view: ExternalEngineConnectionsView = {
    defaults: { "claude-code": "official", codex: "inherit" },
    profiles: [
      { id: "official", engine: "claude-code", mode: "official", hasApiKey: false, builtIn: true },
      { id: "inherit", engine: "claude-code", mode: "inherit", hasApiKey: false, builtIn: true },
      {
        id: "gw",
        engine: "claude-code",
        name: "团队网关",
        mode: "apiKey",
        hasApiKey: true,
        gatewayHost: "gw.example",
      },
      { id: "inherit", engine: "codex", mode: "inherit", hasApiKey: false, builtIn: true },
    ],
  };
  const service = {
    getConnectionProfiles: vi.fn(async () => view),
    updateConnectionProfiles: vi.fn(async () => ({ connections: view })),
  } as unknown as IExternalEngineService;
  const onDraftSelected = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });
  const draft = renderHook(
    (props: { boundProfileId?: string }) =>
      useEngineConnectionControl({
        service,
        engine: "claude-code",
        sessionId: null,
        boundProfileId: props.boundProfileId,
        onDraftSelected,
      }),
    { wrapper, initialProps: { boundProfileId: "official" } },
  );
  await waitFor(() => expect(draft.result.current.choices).toHaveLength(3));
  expect(draft.result.current.choices.map((choice) => choice.name)).toEqual([
    "官方登录",
    "沿用 CLI 配置",
    "团队网关",
  ]);
  expect(draft.result.current.currentId).toBe("official");
  expect(draft.result.current.draftConnectionProfileId()).toBeUndefined();
  act(() => draft.result.current.select("gw"));
  expect(onDraftSelected).toHaveBeenCalledOnce();
  expect(service.updateConnectionProfiles).toHaveBeenCalledWith({
    type: "select",
    engine: "claude-code",
    profileId: "gw",
  });
  // 旧预热 snapshot 仍是 official 时不能把选择器拉回旧值。
  expect(draft.result.current.currentId).toBe("gw");
  expect(draft.result.current.draftConnectionProfileId()).toBe("gw");
  draft.rerender({ boundProfileId: "gw" });
  expect(draft.result.current.currentId).toBe("gw");
  const session = renderHook(
    (props: { boundProfileId?: string }) =>
      useEngineConnectionControl({
        service,
        engine: "claude-code",
        sessionId: "session-a",
        boundProfileId: props.boundProfileId,
        onDraftSelected,
      }),
    { wrapper, initialProps: { boundProfileId: "official" } },
  );
  await waitFor(() => expect(session.result.current.choices).toHaveLength(3));
  expect(session.result.current.label).toBeUndefined();
  session.rerender({ boundProfileId: "gw" });
  expect(session.result.current.label).toBe("团队网关");
  act(() => session.result.current.select("inherit"));
  expect(service.updateConnectionProfiles).toHaveBeenCalledOnce();
});
