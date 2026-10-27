// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor, IExternalEngineService } from "@zcode/services";
import type { ExternalEngineStatus } from "@zcode/shared/external-engine";
import { EngineSettings } from "@/external-engine/index.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const status: ExternalEngineStatus = {
  engine: "claude-code",
  adapter: { installed: false },
  officialCli: { found: true },
  auth: { state: "loggedOut" },
  ready: false,
};
function mount(service?: IExternalEngineService) {
  return render(
    createElement(ServiceProvider, {
      services: { externalEngineService: service } as IServiceAccessor,
      children: createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN",
        children: createElement(TooltipProvider, null, createElement(EngineSettings)),
      }),
    }),
  );
}
afterEach(cleanup);

describe("Agent 引擎设置", () => {
  it("服务缺失时隐藏入口", () => {
    mount();
    expect(screen.queryByTestId("agent-engine-settings")).toBeNull();
  });
  it("只读检测不安装，显式安装后显示返回状态，刷新仍不安装", async () => {
    const service = {
      listStatuses: vi.fn(async () => [status]),
      installAdapter: vi.fn(async () => ({
        ...status,
        adapter: { installed: true, version: "0.95.0" },
      })),
      onStatusChanged: () => ({ dispose() {} }),
    } as unknown as IExternalEngineService;
    mount(service);
    await waitFor(() => expect(service.listStatuses).toHaveBeenCalledOnce());
    expect(service.installAdapter).not.toHaveBeenCalled();
    expect(screen.getByText("claude auth login")).toBeTruthy();
    expect(screen.getByText("codex login")).toBeTruthy();
    fireEvent.click(screen.getByTestId("engine-install-claude-code"));
    await waitFor(() =>
      expect(screen.getByTestId("engine-install-claude-code").textContent).toBe("已安装"),
    );
    expect(service.installAdapter).toHaveBeenCalledExactlyOnceWith("claude-code");
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(service.listStatuses).toHaveBeenCalledTimes(2));
    expect(service.installAdapter).toHaveBeenCalledOnce();
  });
  it("默认收起包名，展开技术详情并复制两家登录命令", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const service = {
      listStatuses: vi.fn(async () => [status]),
      onStatusChanged: () => ({ dispose() {} }),
    } as unknown as IExternalEngineService;
    mount(service);
    await screen.findByText("未登录");
    expect(screen.queryByRole("heading", { name: "Agent 引擎" })).toBeNull();
    const details = screen.getAllByText("技术详情");
    expect(details[0]!.closest("details")?.open).toBe(false);
    fireEvent.click(details[0]!);
    expect(details[0]!.closest("details")?.open).toBe(true);
    for (const engine of ["Claude Code", "Codex"]) {
      fireEvent.click(screen.getByRole("button", { name: `复制 ${engine} 登录命令` }));
    }
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls).toEqual([["claude auth login"], ["codex login"]]);
  });
});

it("会话创建后引擎只读，原生配置值原样回传", async () => {
  const { EngineControls } = await import("@/external-engine/index.js");
  const onConfigChange = vi.fn();
  render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        onConfigChange,
        options: [
          {
            id: "permission-mode",
            name: "Mode",
            currentValue: "read-only",
            options: [
              { value: "read-only", name: "Read only" },
              { value: "agent-full-access", name: "Full access" },
            ],
          },
        ],
      }),
    }),
  );
  expect(screen.queryByTestId("session-engine-select")).toBeNull();
  const indicator = screen.getByTestId("session-engine-indicator");
  expect(indicator.textContent).toBe("");
  expect(indicator.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Codex");
  expect(indicator.querySelector('[role="img"]')?.getAttribute("title")).toBe("Codex");
  expect(indicator.closest("button")).toBeNull();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  fireEvent.keyDown(screen.getByTestId("engine-config-permission-mode"), { key: "ArrowDown" });
  await waitFor(() =>
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Full access" }));
  expect(onConfigChange).toHaveBeenCalledExactlyOnceWith("permission-mode", "agent-full-access");
});

it("配置初始化中与失败时有明确反馈，并保留引擎切换入口", async () => {
  const { EngineControls } = await import("@/external-engine/index.js");
  const onSelectEngine = vi.fn();
  const tree = (props: { loading?: boolean; error?: string }) =>
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, { engine: "codex", onSelectEngine, ...props }),
    });
  const view = render(tree({ loading: true }));
  expect(screen.getByRole("status").textContent).toContain("正在连接引擎");
  expect(screen.getByRole("combobox", { name: "会话引擎" }).hasAttribute("disabled")).toBe(false);
  view.rerender(tree({ error: "ACP adapter exited (code 7)" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("ACP adapter exited (code 7)");
});
