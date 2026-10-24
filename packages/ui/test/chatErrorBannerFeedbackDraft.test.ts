import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const buttonMock = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock("@/components/ui/button.js", async () => {
  const React = await import("react");
  return {
    Button: (props: Record<string, unknown>) => {
      buttonMock.props.push(props);
      const { children, size, variant, ...domProps } = props;
      void size;
      void variant;
      return React.createElement("button", domProps, children);
    },
  };
});
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

function renderBanner(props: Parameters<typeof ChatErrorBanner>[0]) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ChatErrorBanner, props),
    ),
  );
}

describe("ChatErrorBanner 本地恢复动作", () => {
  beforeEach(() => {
    buttonMock.props = [];
    vi.clearAllMocks();
  });

  it("模型缺失只提供配置入口", () => {
    renderBanner({
      error: { code: "model_config_missing", message: "Model config is missing." },
      onOpenModelSettings: vi.fn(),
    });
    expect(buttonMock.props.some((props) => props["aria-label"] === "配置")).toBe(true);
    expect(buttonMock.props.some((props) => props["aria-label"] === "升级")).toBe(false);
    expect(buttonMock.props.some((props) => props["aria-label"] === "反馈问题")).toBe(false);
  });

  it("远程缺少模型时保留目标措辞和配置入口", () => {
    const html = renderBanner({
      error: { code: "model_config_missing", message: "Model config is missing." },
      modelConfigTarget: "remote",
      onOpenModelSettings: vi.fn(),
    });
    expect(html).toContain(zhCN["chat.error.remoteNoAvailableModel"]);
    expect(html).not.toContain(zhCN["chat.error.noAvailableModel"]);
    expect(buttonMock.props.some((props) => props["aria-label"] === "配置")).toBe(true);
  });

  it("远程断线提供重连，同时保留复制排查入口", () => {
    const reconnect = vi.fn();
    renderBanner({
      error: {
        code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
        message: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
      },
      onReconnect: reconnect,
    });
    const button = buttonMock.props.find((props) => props.children === "重新连接");
    expect(button).toBeDefined();
    (button!.onClick as () => void)();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(
      buttonMock.props.some((props) => props["aria-label"] === zhCN["chat.error.copyFull"]),
    ).toBe(true);
    expect(buttonMock.props.some((props) => props["aria-label"] === "反馈问题")).toBe(false);
  });
});
