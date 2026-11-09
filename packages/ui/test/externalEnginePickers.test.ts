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
  fireEvent.click(screen.getByRole("button", { name: "错误详情" }));
  expect(screen.getByTestId("engine-error-details").textContent).toContain("fixture-request");
  expect(screen.getByRole("button", { name: "复制错误详情", hidden: true })).toBeDefined();
});

const choices = [
  { id: "official", name: "官方登录", description: "官方登录" },
  { id: "inherit", name: "沿用 CLI 配置", description: "沿用 CLI" },
  { id: "gateway-a", name: "公司网关", description: "API Key" },
];

it.each([true, false])("草稿和已有会话均不暴露连接入口，设置绑定事实不触发写入：%s", (draft) => {
  const onSelectConnection = vi.fn();
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        placement: "toolbar",
        onSelectEngine: draft ? vi.fn() : undefined,
        connectionChoices: choices,
        connectionProfileId: "gateway-a",
        connectionLabel: "公司网关",
        onSelectConnection,
      }),
    }),
  );
  expect(screen.queryByTestId("engine-config-connection")).toBeNull();
  expect(screen.queryByTestId("session-engine-connection")).toBeNull();
  expect(screen.queryByText("公司网关")).toBeNull();
  expect(onSelectConnection).not.toHaveBeenCalled();
});

it("草稿分段引擎选择支持直接切换，仅选中项显示名称；已有会话固定引擎", () => {
  const onSelectEngine = vi.fn();
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        placement: "selector",
        onSelectEngine,
      }),
    }),
  );
  const selector = screen.getByRole("group", { name: "会话引擎" });
  expect(selector.querySelectorAll("button")).toHaveLength(3);
  expect(screen.getByTestId("session-engine-option-codex").textContent).toContain("Codex");
  expect(screen.getByTestId("session-engine-option-claude-code").textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Claude Code", exact: true }));
  expect(onSelectEngine).toHaveBeenCalledExactlyOnceWith("claude-code");
  view.rerender(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, { engine: "codex" }),
    }),
  );
  expect(screen.queryByTestId("session-engine-select")).toBeNull();
  expect(screen.getByTestId("session-engine-indicator")).toBeDefined();
});

it("权限独立，模型深度共用一个入口，Fast仅在弹层更多且显式选择才写入", () => {
  const onChange = vi.fn();
  const mode = {
    id: "mode",
    name: "Permission",
    currentValue: "fast",
    options: [{ value: "fast", name: "Fast permission" }],
  };
  const model = {
    id: "model",
    name: "Model",
    currentValue: "m",
    options: [{ value: "m", name: "Model M" }],
  };
  const fast = {
    id: "fast_mode",
    name: "Fast",
    currentValue: "off",
    options: [
      { value: "off", name: "Off" },
      { value: "on", name: "On" },
    ],
  };
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        placement: "toolbar",
        onSelectEngine: vi.fn(),
        connectionChoices: [choices[1]!],
        connectionProfileId: "inherit",
        onSelectConnection: vi.fn(),
        options: [fast, effort, model, mode],
        onConfigChange: onChange,
      }),
    }),
  );
  expect(screen.queryByTestId("engine-config-fast_mode")).toBeNull();
  const controls = screen.getByTestId("external-engine-toolbar");
  expect(
    Array.from(controls.querySelectorAll("button[data-testid]")).map((node) =>
      node.getAttribute("data-testid"),
    ),
  ).toEqual(["engine-config-mode", "engine-config-model-effort"]);
  const combined = screen.getByTestId("engine-config-model-effort");
  expect(combined.textContent).toContain("Model M");
  expect(combined.textContent).toContain("Medium");
  expect(screen.queryByTestId("engine-config-more")).toBeNull();
  fireEvent.click(combined);
  expect(screen.getByRole("slider", { name: "Reasoning effort" })).toBeDefined();
  fireEvent.keyDown(screen.getByTestId("engine-config-model"), { key: "ArrowDown" });
  expect(screen.getByRole("menuitemradio", { name: "Model M" })).toBeDefined();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.click(combined);
  fireEvent.click(screen.getByTestId("engine-more-options").querySelector("summary")!);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("engine-config-fast_mode"), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("menuitemradio", { name: "On" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("fast_mode", "on");
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
  expect(draft.result.current.choices.find((choice) => choice.id === "gw")?.description).toContain(
    "gw.example",
  );
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

it("更多内速度选择被拒后保留服务值，Escape 关闭菜单并将焦点还给更多入口", async () => {
  const onChange = vi.fn(async () => false);
  render(
    tree(
      [
        {
          id: "service_tier",
          name: "Fast",
          currentValue: "off",
          options: [
            { value: "off", name: "Off" },
            { value: "on", name: "On" },
          ],
        },
      ],
      onChange,
    ),
  );
  fireEvent.click(screen.getByTestId("engine-config-model-effort"));
  fireEvent.click(screen.getByTestId("engine-more-options").querySelector("summary")!);
  fireEvent.keyDown(screen.getByTestId("engine-config-service_tier"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "On" }), { key: "Enter" });
  await waitFor(() => expect(screen.queryByTestId("engine-more-options")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId("engine-config-model-effort")),
  );
  fireEvent.click(screen.getByTestId("engine-config-model-effort"));
  fireEvent.click(screen.getByTestId("engine-more-options").querySelector("summary")!);
  fireEvent.keyDown(screen.getByTestId("engine-config-service_tier"), { key: "ArrowDown" });
  expect(screen.getByRole("menuitemradio", { name: "Off" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("engine-more-options")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId("engine-config-model-effort")),
  );
});

it("远程工作区草稿的选择器灰显外部引擎并就地说明原因，只能选择 YCode", async () => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const onSelectEngine = vi.fn();
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "zcode",
        onSelectEngine,
        externalEngineUnavailableReason: "远程工作区暂不支持",
      }),
    }),
  );
  const codex = screen.getByRole("button", { name: "Codex", exact: true });
  const claude = screen.getByRole("button", { name: "Claude Code", exact: true });
  const reason = screen.getByText("远程工作区暂不支持", { exact: true });
  expect(reason.closest("[hidden], [aria-hidden=true], .hidden, .sr-only")).toBeNull();
  expect(getComputedStyle(reason).display).not.toBe("none");
  expect(getComputedStyle(reason).visibility).not.toBe("hidden");
  expect(screen.getByRole("group", { name: "会话引擎" }).getAttribute("aria-describedby")).toBe(
    reason.id,
  );
  for (const option of [codex, claude]) {
    expect(option.hasAttribute("disabled")).toBe(true);
    expect(option.getAttribute("aria-describedby")).toBe(reason.id);
    expect(option.getAttribute("title")).toContain("远程工作区暂不支持");
  }
  const builtin = screen.getByRole("button", { name: "ZCode", exact: true });
  expect(builtin.hasAttribute("disabled")).toBe(false);
  expect(builtin.textContent).not.toContain("远程工作区暂不支持");
  fireEvent.click(codex);
  expect(onSelectEngine).not.toHaveBeenCalled();
});

it("展示插槽共享一个picker owner，权限与模型弹层互斥，模型目录可用时不伪造深度", async () => {
  const model = {
    id: "model",
    name: "Model",
    currentValue: "m",
    options: [{ value: "m", name: "Native model" }],
  };
  const mode = {
    id: "mode",
    name: "Permission",
    currentValue: "safe",
    options: [{ value: "safe", name: "Safe" }],
  };
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        placement: "toolbar",
        options: [model, effort, mode],
        onConfigChange: vi.fn(),
        renderLayout: ({ leadingActions, modelControls }) =>
          createElement(
            "div",
            {},
            createElement("div", { "data-testid": "leading-slot" }, leadingActions),
            createElement("div", { "data-testid": "model-slot" }, modelControls),
          ),
      }),
    }),
  );
  expect(screen.getByTestId("leading-slot").querySelectorAll("button")).toHaveLength(1);
  expect(screen.getByTestId("model-slot").querySelectorAll("button")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("engine-config-model-effort"));
  expect(screen.getByRole("slider")).toBeDefined();
  fireEvent.keyDown(screen.getByTestId("engine-config-mode"), { key: "ArrowDown" });
  await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
  expect(screen.getByRole("menuitemradio", { name: "Safe" })).toBeDefined();
});

it.each(["model", "fast"])("空深度目录不禁用有效%s，打开不写配置，选择回传原始值", (capability) => {
  const onChange = vi.fn();
  const option =
    capability === "model"
      ? {
          id: "model",
          name: "Model",
          currentValue: "native-a",
          options: [
            { value: "native-a", name: "Native A" },
            { value: "native-b", name: "Native B" },
          ],
        }
      : {
          id: "fast",
          name: "Fast mode",
          currentValue: "native-off",
          options: [
            { value: "native-off", name: "Off" },
            { value: "native-on", name: "On" },
          ],
        };
  render(tree([{ ...effort, currentValue: "", options: [] }, option], onChange));
  const trigger = screen.getByTestId(
    capability === "model" ? "engine-config-model-effort" : "engine-config-reasoning_effort",
  );
  expect(trigger.hasAttribute("disabled")).toBe(false);
  fireEvent.click(trigger);
  expect(screen.getByRole("slider").hasAttribute("disabled")).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
  if (capability === "model") {
    fireEvent.keyDown(screen.getByTestId("engine-config-model"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Native B" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "native-b");
  } else {
    fireEvent.click(screen.getByTestId("engine-more-options").querySelector("summary")!);
    fireEvent.keyDown(screen.getByTestId("engine-config-fast"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "On" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fast", "native-on");
  }
});
