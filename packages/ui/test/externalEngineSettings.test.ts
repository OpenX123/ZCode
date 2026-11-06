// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor, IExternalEngineService } from "@zcode/services";
import type {
  ExternalEngineConnectionsView,
  ExternalEngineStatus,
} from "@zcode/shared/external-engine";
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
const connectionsView: ExternalEngineConnectionsView = {
  defaults: { "claude-code": "official", codex: "inherit" },
  profiles: [
    { id: "official", engine: "claude-code", mode: "official", hasApiKey: false, builtIn: true },
    { id: "inherit", engine: "claude-code", mode: "inherit", hasApiKey: false, builtIn: true },
    { id: "inherit", engine: "codex", mode: "inherit", hasApiKey: false, builtIn: true },
    {
      id: "gw",
      engine: "codex",
      name: "公司网关",
      mode: "apiKey",
      baseUrl: "https://gw.example/v1",
      hasApiKey: true,
      gatewayHost: "gw.example",
    },
    { id: "old", engine: "codex", name: "旧网关", mode: "apiKey", hasApiKey: true, hidden: true },
  ],
};
function connectionService(overrides: Partial<IExternalEngineService> = {}) {
  return {
    listStatuses: vi.fn(async () => [status]),
    getConnectionProfiles: vi.fn(async () => connectionsView),
    updateConnectionProfiles: vi.fn(async () => ({
      connections: connectionsView,
      profileId: "new-profile",
    })),
    login: vi.fn(async () => {}),
    cancelLogin: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({ status: "success" as const, latencyMs: 1234 })),
    cancelConnectionTest: vi.fn(async () => {}),
    onStatusChanged: () => ({ dispose() {} }),
    onConnectionProfilesChanged: () => ({ dispose() {} }),
    ...overrides,
  } as unknown as IExternalEngineService;
}
function mount(service?: IExternalEngineService, connectivityWorkspacePath = "/workspace/local") {
  return render(
    createElement(ServiceProvider, {
      services: { externalEngineService: service } as IServiceAccessor,
      children: createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN",
        children: createElement(
          TooltipProvider,
          null,
          createElement(EngineSettings, { connectivityWorkspacePath }),
        ),
      }),
    }),
  );
}
afterEach(cleanup);

describe("Agent 引擎设置", () => {
  it("两家引擎列出连接配置的名称、方式、网关与默认标记，隐藏配置不出现", async () => {
    mount(connectionService());
    const gateway = await screen.findByTestId("engine-connection-codex-gw");
    expect(gateway.textContent).toContain("公司网关");
    expect(gateway.textContent).toContain("API Key · 使用网关 gw.example");
    expect(screen.getByTestId("engine-connection-codex-inherit").textContent).toContain("默认");
    const claudeOfficial = screen.getByTestId("engine-connection-claude-code-official");
    expect(claudeOfficial.textContent).toContain("官方登录");
    expect(claudeOfficial.textContent).toContain("默认");
    expect(screen.getByTestId("engine-connection-claude-code-inherit").textContent).toContain(
      "沿用 CLI 配置",
    );
    expect(screen.queryByText("旧网关")).toBeNull();
    // 内置配置不可编辑或删除。
    expect(claudeOfficial.textContent).not.toContain("编辑");
  });

  it("新建 API Key 连接只经 Host 命令保存，密钥不回显", async () => {
    const service = connectionService();
    mount(service);
    fireEvent.click(await screen.findByTestId("engine-connection-claude-code-add"));
    fireEvent.change(screen.getByLabelText("名称（可选）"), { target: { value: "团队网关" } });
    fireEvent.change(screen.getByLabelText("API 地址（Anthropic 兼容）"), {
      target: { value: "https://claude-gw.example" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "private-ui-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("连接已保存，并设为新的 Claude Code 会话默认连接。");
    expect(service.updateConnectionProfiles).toHaveBeenCalledExactlyOnceWith({
      type: "create",
      engine: "claude-code",
      name: "团队网关",
      mode: "apiKey",
      baseUrl: "https://claude-gw.example",
      model: "",
      apiKey: "private-ui-key",
    });
    expect(screen.queryByTestId("engine-connection-claude-code-form")).toBeNull();
    expect(screen.queryByText("private-ui-key")).toBeNull();
  });

  it("编辑生成新配置且方式不可改，删除需二次确认，设为默认走选择命令", async () => {
    const service = connectionService();
    mount(service);
    const row = await screen.findByTestId("engine-connection-codex-gw");
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    const form = screen.getByTestId("engine-connection-codex-form");
    expect((within(form).getByLabelText("Codex 连接方式") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(within(form).getByLabelText("API Key").getAttribute("placeholder")).toContain("已保存");
    fireEvent.change(within(form).getByLabelText("默认模型（可选）"), {
      target: { value: "model-b" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await screen.findByText("连接已更新；已有会话保留原连接。");
    expect(service.updateConnectionProfiles).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "edit",
        profileId: "gw",
        model: "model-b",
        apiKey: undefined,
      }),
    );
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(service.updateConnectionProfiles).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByRole("button", { name: "确认删除" }));
    await screen.findByText("连接已删除；已有会话仍可继续使用。");
    expect(service.updateConnectionProfiles).toHaveBeenLastCalledWith({
      type: "delete",
      engine: "codex",
      profileId: "gw",
    });
    fireEvent.click(within(row).getByRole("button", { name: "设为默认" }));
    await screen.findByText("新的 Codex 会话将使用此连接。");
    expect(service.updateConnectionProfiles).toHaveBeenLastCalledWith({
      type: "select",
      engine: "codex",
      profileId: "gw",
    });
  });

  it("连接配置失败显示可操作的安全原因，不回显异常中的密钥", async () => {
    const service = connectionService({
      updateConnectionProfiles: vi.fn(async () => {
        throw new Error("external_engine_connection_url_invalid secret-ui-credential");
      }),
    });
    mount(service);
    fireEvent.click(await screen.findByTestId("engine-connection-codex-add"));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "secret-ui-credential" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("API 地址无效");
    expect(screen.queryByText(/secret-ui-credential/)).toBeNull();
  });

  it("测试连接显示耗时或结构化失败并可取消；没有本地项目时禁用", async () => {
    let finish!: (value: unknown) => void;
    const testConnection = vi
      .fn()
      .mockResolvedValueOnce({ status: "success", latencyMs: 1234 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const service = connectionService({ testConnection });
    const view = mount(service);
    fireEvent.click(await screen.findByTestId("engine-connection-codex-test-gw"));
    const row = screen.getByTestId("engine-connection-codex-gw");
    await waitFor(() => expect(row.textContent).toContain("连接成功 · 1.2 秒"));
    expect(testConnection).toHaveBeenCalledWith({
      engine: "codex",
      profileId: "gw",
      workspacePath: "/workspace/local",
    });
    fireEvent.click(screen.getByTestId("engine-connection-codex-test-gw"));
    fireEvent.click(within(row).getByRole("button", { name: "取消测试" }));
    expect(service.cancelConnectionTest).toHaveBeenCalledOnce();
    finish({
      status: "failed",
      latencyMs: 800,
      failure: {
        code: "authentication",
        httpStatus: 401,
        requestId: "req_fixture",
        message: "invalid key",
      },
    });
    await waitFor(() => expect(within(row).getByRole("alert").textContent).toContain("HTTP 401"));
    expect(within(row).getByRole("alert").textContent).toContain("req_fixture");
    expect(within(row).getByRole("alert").textContent).toContain("认证未通过");
    view.unmount();
    mount(connectionService(), "");
    const disabled = await screen.findByTestId("engine-connection-codex-test-gw");
    expect(disabled.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("打开一个本地项目后才能测试连接。").length).toBeGreaterThan(0);
  });

  it("网关用户显示使用网关而不是未登录；Claude 官方登录按钮调用 Host 登录", async () => {
    const service = connectionService({
      listStatuses: vi.fn(async () => [
        {
          ...status,
          engine: "codex" as const,
          auth: { state: "loggedOut" as const, gatewayHost: "gw.example" },
        },
        { ...status, auth: { state: "loggedIn" as const, label: "subscription" } },
      ]),
    });
    mount(service);
    await waitFor(() =>
      expect(screen.getByTestId("engine-auth-codex").textContent).toBe("使用网关 gw.example"),
    );
    expect(screen.getByTestId("engine-auth-claude-code").textContent).toBe("已登录 · 订阅");
    const official = screen.getByTestId("engine-connection-claude-code-official");
    fireEvent.click(within(official).getByRole("button", { name: "在浏览器中登录" }));
    await screen.findByText("官方登录完成，将用于新的 Claude Code 会话。");
    expect(service.login).toHaveBeenCalledExactlyOnceWith("official");
  });
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
