// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    {
      id: "official",
      engine: "claude-code",
      mode: "official",
      hasApiKey: false,
      builtIn: true,
    },
    {
      id: "inherit",
      engine: "claude-code",
      mode: "inherit",
      hasApiKey: false,
      builtIn: true,
    },
    {
      id: "inherit",
      engine: "codex",
      mode: "inherit",
      hasApiKey: false,
      builtIn: true,
    },
    {
      id: "gw",
      engine: "codex",
      name: "公司网关",
      mode: "apiKey",
      baseUrl: "https://gw.example/v1",
      hasApiKey: true,
      gatewayHost: "gw.example",
    },
    {
      id: "old",
      engine: "codex",
      name: "旧网关",
      mode: "apiKey",
      hasApiKey: true,
      hidden: true,
    },
  ],
};
function connectionService(overrides: Partial<IExternalEngineService> = {}) {
  return {
    listStatuses: vi.fn(async () => [status]),
    getStatus: vi.fn(async (engine) => ({
      ...status,
      engine,
      connectionProfileId: engine === "codex" ? "inherit" : "official",
    })),
    getConnectionProfiles: vi.fn(async () => connectionsView),
    updateConnectionProfiles: vi.fn(async () => ({
      connections: connectionsView,
    })),
    login: vi.fn(async () => {}),
    cancelLogin: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({
      status: "success" as const,
      latencyMs: 1234,
    })),
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

describe("ACP 设置主从诊断", () => {
  it("先展示配置，所选引擎独立诊断，切换查看不写默认", async () => {
    const getStatus = vi.fn((engine: string) =>
      engine === "claude-code"
        ? new Promise<ExternalEngineStatus>(() => {})
        : Promise.reject(new Error("secret-untrusted-diagnostic")),
    );
    const service = connectionService({ getStatus });
    mount(service);
    await screen.findByTestId("engine-connection-claude-code-official");
    expect(getStatus).toHaveBeenCalledExactlyOnceWith("claude-code");
    expect(screen.getByTestId("engine-settings-codex").hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await screen.findByTestId("engine-settings-codex");
    await screen.findByText("检查未完成，请重试。");
    expect(document.body.textContent).not.toContain("secret-untrusted-diagnostic");
    expect(service.updateConnectionProfiles).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledWith("codex");
  });
  it("廉价快检迟到不覆盖完整检查的就绪状态", async () => {
    const quick = Promise.withResolvers<boolean>();
    mount(
      connectionService({
        isLaunchReady: vi.fn(() => quick.promise),
        getStatus: vi.fn(async (engine) => ({
          ...status,
          engine,
          ready: true,
          connectionProfileId: "official",
        })),
      }),
    );
    const item = screen.getByRole("button", { name: "Claude Code" });
    await waitFor(() => expect(item.textContent).toContain("运行环境可用"));
    await act(async () => {
      quick.resolve(false);
    });
    expect(item.textContent).toContain("运行环境可用");
  });
  it.each([
    ["codex", false],
    ["claude-code", false],
    ["codex", true],
    ["claude-code", true],
  ] as const)(
    "%s 沿用 CLI API Key 不显示认证通过（结构化检查：%s）",
    async (engine, structured) => {
      mount(
        connectionService({
          getConnectionProfiles: vi.fn(async () => ({
            ...connectionsView,
            defaults: { "claude-code": "inherit", codex: "inherit" },
          })),
          getStatus: vi.fn(async (selected) => ({
            ...status,
            engine: selected,
            connectionProfileId: "inherit",
            auth: { state: "loggedIn", label: "apiKey" },
            ...(structured
              ? {
                  checks: [
                    {
                      id: "authentication",
                      state: "unknown",
                      source: "cli",
                      connectionProfileId: "inherit",
                      actions: ["test"],
                    },
                  ],
                }
              : {}),
          })),
        }),
      );
      if (engine === "codex") fireEvent.click(screen.getByRole("button", { name: "Codex" }));
      const detail = await screen.findByTestId(`engine-connection-${engine}-detail`);
      await waitFor(() =>
        expect(
          within(detail).getByTestId("engine-check-authentication").querySelector("summary")
            ?.textContent,
        ).toContain("尚待验证"),
      );
      const check = within(detail).getByTestId("engine-check-authentication");
      expect(check.querySelector("summary")?.textContent).not.toContain("已通过");
      expect(check.textContent).toContain("CLI 检测到 API Key；远端认证须通过测试模型响应确认。");
      expect(check.textContent).toContain("当前 CLI 配置与状态命令");
      expect(check.textContent).not.toContain("系统凭据存储");
      expect(check.textContent).not.toContain("密钥已保存");
    },
  );
  it("非诊断配置不显示默认身份认证，点击详情不写上次使用", async () => {
    const service = connectionService({
      getStatus: vi.fn(async () => ({
        ...status,
        connectionProfileId: "official",
        auth: { state: "loggedIn", label: "subscription" },
      })),
    });
    mount(service);
    await screen.findByTestId("engine-connection-claude-code-official");
    fireEvent.click(screen.getByTestId("engine-connection-claude-code-view-inherit"));
    const detail = await screen.findByTestId("engine-connection-claude-code-detail");
    expect(detail.textContent).toContain("尚未检查此连接的认证");
    expect(detail.textContent).not.toContain("已登录");
    expect(service.updateConnectionProfiles).not.toHaveBeenCalled();
  });
  it("切换引擎保留原连接测试与取消入口，查看始终不写默认", async () => {
    const completion = Promise.withResolvers<{ status: "cancelled" }>();
    const service = connectionService({ testConnection: vi.fn(() => completion.promise) });
    mount(service);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-view-gw"));
    fireEvent.click(screen.getByTestId("engine-connection-codex-test-gw"));
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "取消测试" }));
    expect(service.cancelConnectionTest).toHaveBeenCalledOnce();
    expect(service.updateConnectionProfiles).not.toHaveBeenCalled();
    completion.resolve({ status: "cancelled" });
    await screen.findByText("测试已取消");
  });

  it("编辑使用共享弹窗并提示只影响新会话，取消不保存", async () => {
    const service = connectionService();
    mount(service);
    fireEvent.click(await screen.findByTestId("engine-connection-claude-code-add"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("仅对新会话生效");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(service.updateConnectionProfiles).not.toHaveBeenCalled();
  });
});

describe("Agent 引擎设置", () => {
  it("两家引擎列出连接配置的名称、方式、网关与默认标记，隐藏配置不出现", async () => {
    mount(connectionService());
    const gateway = await screen.findByTestId("engine-connection-codex-gw");
    expect(gateway.textContent).toContain("公司网关");
    expect(gateway.textContent).toContain("API Key · 使用网关 gw.example");
    expect(screen.getByTestId("engine-connection-codex-inherit").textContent).toContain("上次使用");
    const claudeOfficial = screen.getByTestId("engine-connection-claude-code-official");
    expect(claudeOfficial.textContent).toContain("官方登录");
    expect(claudeOfficial.textContent).toContain("上次使用");
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
    fireEvent.change(screen.getByLabelText("名称（可选）"), {
      target: { value: "团队网关" },
    });
    fireEvent.change(screen.getByLabelText("API 地址（Anthropic 兼容）"), {
      target: { value: "https://claude-gw.example" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "private-ui-key" },
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-view-gw"));
    const row = screen.getByTestId("engine-connection-codex-gw");
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
    fireEvent.click(within(row).getByRole("button", { name: "用于新任务" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-view-gw"));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-test-gw"));
    const row = screen.getByTestId("engine-connection-codex-gw");
    await waitFor(() => expect(row.textContent).toContain("测试通过 · 1.2 秒"));
    expect(within(row).queryByTestId("engine-connection-test-warnings")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-view-gw"));
    const disabled = await screen.findByTestId("engine-connection-codex-test-gw");
    expect(disabled.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("打开一个本地项目后才能测试连接。").length).toBeGreaterThan(0);
  });

  it("测试通过带警告时显示「测试通过」并用警告色列出每条警告", async () => {
    const testConnection = vi.fn().mockResolvedValueOnce({
      status: "success",
      latencyMs: 2100,
      warnings: [{ message: "Model metadata for gw-model not found." }, { message: "Second" }],
    });
    mount(connectionService({ testConnection }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-view-gw"));
    fireEvent.click(await screen.findByTestId("engine-connection-codex-test-gw"));
    const row = screen.getByTestId("engine-connection-codex-gw");
    await waitFor(() => expect(row.textContent).toContain("测试通过 · 2.1 秒"));
    expect(within(row).queryByRole("alert")).toBeNull();
    const warnings = within(row).getByTestId("engine-connection-test-warnings");
    expect(warnings.className).toContain("text-warning");
    expect(warnings.textContent).toContain("警告");
    expect(
      within(warnings)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Model metadata for gw-model not found.", "Second"]);
  });

  it("网关用户显示使用网关而不是未登录；Claude 官方登录按钮调用 Host 登录", async () => {
    const service = connectionService({
      getStatus: vi.fn(async (engine) => ({
        ...status,
        engine,
        connectionProfileId: engine === "codex" ? "inherit" : "official",
        auth:
          engine === "codex"
            ? { state: "loggedOut" as const, gatewayHost: "gw.example" }
            : { state: "loggedIn" as const, label: "subscription" },
      })),
    });
    mount(service);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() =>
      expect(screen.getByTestId("engine-auth-codex").textContent).toBe("使用网关 gw.example"),
    );
    expect(screen.getByTestId("engine-auth-claude-code").textContent).toBe("已登录 · 订阅");
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
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
      getStatus: vi.fn(async () => status),
      installAdapter: vi.fn(async () => ({
        ...status,
        adapter: { installed: true, version: "0.95.0" },
      })),
      onStatusChanged: () => ({ dispose() {} }),
    } as unknown as IExternalEngineService;
    mount(service);
    await waitFor(() => expect(service.getStatus).toHaveBeenCalledOnce());
    expect(service.installAdapter).not.toHaveBeenCalled();
    expect(screen.getByText("claude auth login")).toBeTruthy();
    expect(screen.getByText("codex login")).toBeTruthy();
    fireEvent.click(screen.getByTestId("engine-install-claude-code"));
    await waitFor(() =>
      expect(screen.getByTestId("engine-install-claude-code").textContent).toBe("已安装"),
    );
    expect(service.installAdapter).toHaveBeenCalledExactlyOnceWith("claude-code");
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(service.getStatus).toHaveBeenCalledTimes(2));
    expect(service.installAdapter).toHaveBeenCalledOnce();
  });
  it("默认收起包名，展开技术详情并复制两家登录命令", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const service = {
      getStatus: vi.fn(async () => status),
      onStatusChanged: () => ({ dispose() {} }),
    } as unknown as IExternalEngineService;
    mount(service);
    await screen.findByTestId("engine-check-cli");
    expect(screen.queryByRole("heading", { name: "Agent 引擎" })).toBeNull();
    const details = screen.getAllByText("技术详情");
    expect(details[0]!.closest("details")?.open).toBe(false);
    fireEvent.click(details[0]!);
    expect(details[0]!.closest("details")?.open).toBe(true);
    for (const engine of ["Claude Code", "Codex"]) {
      fireEvent.click(screen.getByRole("button", { name: engine }));
      const detail = within(
        screen.getByTestId(`engine-settings-${engine === "Codex" ? "codex" : "claude-code"}`),
      )
        .getByText("技术详情")
        .closest("details");
      if (!detail?.open) fireEvent.click(within(detail!).getByText("技术详情"));
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
  // W2：输入框上方不再有引擎胶囊或固定 Logo；引擎图标随右下角入口显示。
  expect(screen.queryByTestId("session-engine-select")).toBeNull();
  expect(screen.queryByTestId("session-engine-indicator")).toBeNull();
  const trigger = screen.getByTestId("engine-config-model-effort");
  expect(trigger.querySelector('[data-task-client-logo="codex"]')?.getAttribute("aria-label")).toBe(
    "Codex",
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  // W1：非 `mode` 的原生选项进入弹层「更多选项」。
  fireEvent.click(trigger);
  fireEvent.click(screen.getByTestId("engine-more-options").querySelector("summary")!);
  fireEvent.keyDown(screen.getByTestId("engine-config-permission-mode"), {
    key: "ArrowDown",
  });
  await waitFor(() =>
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Full access" }));
  expect(onConfigChange).toHaveBeenCalledExactlyOnceWith("permission-mode", "agent-full-access");
});

// 已有会话的空闲重连 / 停止后恢复仍显示连接中（CONTRACT.md「历史会话的连接状态」）；草稿见下一用例。
it("已有会话配置连接中与失败时有明确反馈，并保留引擎切换入口", async () => {
  const { EngineControls, EngineSwitchRow } = await import("@/external-engine/index.js");
  const onSelectEngine = vi.fn();
  const tree = (props: { loading?: boolean; error?: string }) =>
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        engineSwitchRow: createElement(EngineSwitchRow, { engine: "codex", onSelectEngine }),
        ...props,
      }),
    });
  const view = render(tree({ loading: true }));
  expect(screen.getByRole("status").textContent).toContain("正在连接引擎");
  // 引擎切换入口在模型弹层顶部，连接中仍可打开。
  fireEvent.click(screen.getByTestId("engine-config-model-effort"));
  expect(screen.getByRole("radio", { name: "Codex" }).hasAttribute("disabled")).toBe(false);
  view.rerender(tree({ error: "ACP adapter exited (code 7)" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("ACP adapter exited (code 7)");
});

// 2026-11-08 草稿无感（external-agent-engines-spec「草稿连接中提示」）：草稿就绪前不显示
// “正在连接引擎…”，只把原生配置选择器显示为禁用；引擎选择仍可用，就绪后选择器可用。
it("草稿原生配置就绪前选择器禁用且无连接中文案，就绪后可用", async () => {
  const { EngineControls, EngineSwitchRow } = await import("@/external-engine/index.js");
  const options = [
    {
      id: "model",
      name: "Model",
      currentValue: "gpt-a",
      options: [
        { value: "gpt-a", name: "GPT A" },
        { value: "gpt-b", name: "GPT B" },
      ],
    },
  ];
  const tree = (configPending: boolean) =>
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(EngineControls, {
        engine: "codex",
        engineSwitchRow: createElement(EngineSwitchRow, {
          engine: "codex",
          onSelectEngine: vi.fn(),
        }),
        onConfigChange: vi.fn(),
        options,
        configPending,
      }),
    });
  const view = render(tree(true));
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.body.textContent).not.toContain("正在连接引擎");
  fireEvent.click(screen.getByTestId("engine-config-model-effort"));
  expect(screen.getByTestId("engine-config-model").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("radio", { name: "Codex" }).hasAttribute("disabled")).toBe(false);
  view.rerender(tree(false));
  expect(screen.getByTestId("engine-config-model").hasAttribute("disabled")).toBe(false);
});
