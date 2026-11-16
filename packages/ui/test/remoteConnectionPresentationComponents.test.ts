// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { ZCODE_VERSION } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { RemoteTaskDeviceLabel } from "@/remote-connection/RemoteTaskDeviceLabel.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";
import { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import zh from "@/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          zh[id] ?? id,
        ),
    },
  }),
}));
afterEach(cleanup);

it.each([false, true])(
  "缓存恢复向导实际按钮使用 locator，复制固定步骤且保留原重试：升级=%s",
  async (upgradeRequired) => {
    const cacheRecovery = {
      kind: "source-server-cache-lock" as const,
      version: ZCODE_VERSION,
      target: "linux-x64" as const,
      sha256: "a".repeat(64),
    };
    const pending = Promise.withResolvers<{ success: boolean; error?: string }>();
    const open = vi.fn(() => pending.promise);
    const copy = vi.fn<(_text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const onRetry = vi.fn();
    const props = {
      kind: "ssh" as const,
      loading: false,
      logs: [],
      errorMessage: "safe [redacted]",
      rawError: "safe [redacted]",
      errorCode: "source-server-cache-lock-interrupted",
      cacheRecovery,
      upgradeRequired,
      onRetry,
      onBack: vi.fn(),
    };
    const view = render(
      createElement(PlatformProvider, {
        platform: { openSourceServerCacheRecoveryDirectory: open } as never,
        children: createElement(RemoteConnectionConnectingStep, props),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "定位本机锁文件夹" }));
    expect(open).toHaveBeenCalledWith(cacheRecovery);
    fireEvent.click(screen.getByRole("button", { name: "复制操作步骤" }));
    expect(copy.mock.calls[0]?.[0]).toContain("退出");
    for (const step of [
      "保留文件管理器窗口",
      "保存工作",
      "全部应用实例",
      "Cmd+Q",
      "取消退出确认",
      "等待 Host 清理完成",
      "仅手动删除",
      ".tar.gz.lock",
      "保留其他归档和 SHA 目录",
      "原入口显式重试",
    ])
      expect(copy.mock.calls[0]?.[0]).toContain(step);
    expect(copy.mock.calls[0]?.[0]).not.toContain(cacheRecovery.sha256);
    expect(copy.mock.calls[0]?.[0]).not.toContain(cacheRecovery.target);
    expect(document.body.textContent).not.toContain(cacheRecovery.sha256);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
    view.rerender(
      createElement(PlatformProvider, {
        platform: { openSourceServerCacheRecoveryDirectory: open } as never,
        children: createElement(RemoteConnectionConnectingStep, {
          ...props,
          cacheRecovery: undefined,
          errorCode: "remote-host-unreachable",
          errorMessage: "new error",
          rawError: "new error",
        }),
      }),
    );
    await act(async () => pending.resolve({ success: false, error: "old failure" }));
    expect(screen.queryByRole("button", { name: "定位本机锁文件夹" })).toBeNull();
    expect(document.body.textContent).not.toContain("old failure");
  },
);

it("缓存恢复定位只显示安全反馈，同值新错误也判废旧完成结果", async () => {
  const cacheRecovery = {
    kind: "source-server-cache-lock" as const,
    version: ZCODE_VERSION,
    target: "linux-x64" as const,
    sha256: "a".repeat(64),
  };
  const pending = Promise.withResolvers<{ success: boolean; error?: string }>();
  const open = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ success: false, error: "/native/private/" + cacheRecovery.sha256 });
  const props = {
    kind: "ssh" as const,
    loading: false,
    logs: [],
    errorMessage: "safe",
    errorCode: "source-server-cache-lock-interrupted",
    cacheRecovery,
    onRetry: vi.fn(),
    onBack: vi.fn(),
  };
  const element = (recovery: typeof cacheRecovery) =>
    createElement(PlatformProvider, {
      platform: { openSourceServerCacheRecoveryDirectory: open } as never,
      children: createElement(RemoteConnectionConnectingStep, {
        ...props,
        cacheRecovery: recovery,
      }),
    });
  const view = render(element(cacheRecovery));
  fireEvent.click(screen.getByRole("button", { name: "定位本机锁文件夹" }));
  view.rerender(element({ ...cacheRecovery }));
  await act(async () => pending.resolve({ success: true }));
  expect(screen.queryByText(zh["remote.cacheRecovery.opened"]!)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "定位本机锁文件夹" }));
  expect(await screen.findByText(zh["remote.cacheRecovery.failed"]!)).toBeTruthy();
  expect(document.body.textContent).not.toContain("/native/private/");
  expect(document.body.textContent).not.toContain(cacheRecovery.sha256);
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});

it.each(["no-locator", "bad-locator", "no-capability", "wrong-code"])(
  "缓存恢复动作缺少严格资格时不可用：%s",
  (missing) => {
    const recovery = {
      kind: "source-server-cache-lock",
      version: ZCODE_VERSION,
      target: "linux-x64",
      sha256: "a".repeat(64),
    };
    render(
      createElement(PlatformProvider, {
        platform: (missing === "no-capability"
          ? {}
          : { openSourceServerCacheRecoveryDirectory: vi.fn() }) as never,
        children: createElement(RemoteConnectionConnectingStep, {
          kind: "ssh",
          loading: false,
          logs: [],
          errorMessage: "safe",
          errorCode:
            missing === "wrong-code"
              ? "remote-download-failed"
              : "source-server-cache-lock-interrupted",
          cacheRecovery:
            missing === "no-locator"
              ? undefined
              : missing === "bad-locator"
                ? { ...recovery, path: "/secret" }
                : recovery,
          onRetry: vi.fn(),
          onBack: vi.fn(),
        } as never),
      }),
    );
    expect(screen.queryByRole("button", { name: "定位本机锁文件夹" })).toBeNull();
  },
);

it("恢复标签使用短句并分隔状态，详情保留完整恢复说明", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
    target: { kind: "docker", container: "dev" },
  });
  const { container } = render(
    createElement(RemoteProjectConnectionDetails, {
      tab: {
        id: "project",
        kind: "workspace",
        label: "Project",
        workspacePath: "/srv/project",
        remoteTarget: { kind: "docker", container: "dev" },
      },
      deviceName: "Dev",
      presentation,
    }),
  );
  expect(container.querySelector("[data-remote-connection-status]")?.textContent).toBe(
    "连接中 · 自动恢复 2/3",
  );
  expect(screen.getByText("正在自动恢复连接（2/3）")).toBeTruthy();
  expect(screen.getByText("Docker · dev")).toBeTruthy();
});

it("状态标签与详情卡显示需要处理及更新方向", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "needs-upgrade",
    upgradeTarget: "controller",
  });
  const { container } = render(
    createElement(RemoteProjectConnectionDetails, {
      tab: { id: "project", kind: "workspace", label: "Project", workspacePath: "/srv/project" },
      deviceName: "Dev",
      presentation,
    }),
  );
  expect(screen.getByText("需要处理", { exact: false })).toBeTruthy();
  expect(screen.getByText("需要更新")).toBeTruthy();
  expect(container.querySelector('[data-remote-connection-status="pending"]')?.className).toContain(
    "text-warning-surface-foreground",
  );
});

it("导航点读取模型的进行中色，恢复进度是可见文字", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
  });
  const { container } = render(
    createElement(
      "div",
      null,
      createElement(RemoteConnectionNavigationDot, { presentation }),
      createElement(RemoteConnectionStatusTag, { presentation }),
    ),
  );
  expect(screen.getByText("自动恢复 2/3")).toBeTruthy();
  expect(
    container.querySelector('[data-remote-navigation-status="connecting"]')?.className,
  ).toContain("progress-surface-foreground");
});

it("任务行设备标签读取同一服务快照的安装门禁", async () => {
  const emitter = new Emitter();
  const management = {
    getSnapshot: async () => ({
      servers: [{ sourceServerId: "device", displayName: "Dev", installState: "installed" }],
      profiles: [
        {
          profileId: "profile",
          sourceServerId: "device",
          target: { kind: "docker", container: "dev" },
        },
      ],
      states: [{ profileId: "profile", state: "needs-install", updatedAt: 1 }],
    }),
    onDidChangeState: emitter.event,
  };
  render(
    createElement(ServiceProvider, {
      services: { sourceServerManagementService: management } as never,
      children: createElement(RemoteTaskDeviceLabel, {
        task: { workspacePath: "/srv", sourceServerId: "device", serverDisplayName: "Dev" },
      }),
    }),
  );
  expect(await screen.findByText("需要安装")).toBeTruthy();
});

it("向导按下载失败分类展示标题，只在本地下载时提供切换操作", () => {
  const onRetry = vi.fn();
  const target = {
    kind: "ssh" as const,
    host: "dev",
    username: "user",
    assetInstallMode: "remote-download" as const,
  };
  const child = createElement(RemoteConnectionConnectingStep, {
    kind: "ssh",
    target,
    loading: false,
    logs: [],
    errorMessage: "download failed",
    errorCode: "remote-download-failed",
    onBack: vi.fn(),
    onRetry,
    onUseRemoteDownload: vi.fn(),
  });
  render(createElement(PlatformProvider, { platform: {} as never, children: child }));
  expect(screen.getByText("资源下载失败")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "改用远端下载" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it.each([false, true])("连接中补凭据可显隐且不触发提交：口令=%s", (passphrase) => {
  const onSubmit = vi.fn();
  const child = createElement(RemoteConnectionConnectingStep, {
    kind: "ssh",
    errorMessage: "",
    loading: false,
    logs: [],
    onBack: vi.fn(),
    onRetry: vi.fn(),
    credentials: { value: "secret", passphrase, onChange: vi.fn(), onSubmit },
  });
  render(createElement(PlatformProvider, { platform: {} as never, children: child }));
  const input = screen.getByLabelText(passphrase ? "私钥口令（可选）" : "密码");
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(input.getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
  expect(input.getAttribute("type")).toBe("password");
  expect(onSubmit).not.toHaveBeenCalled();
});
