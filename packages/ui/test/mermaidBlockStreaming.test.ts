// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const { renderMermaid } = vi.hoisted(() => ({ renderMermaid: vi.fn() }));
vi.mock("@streamdown/mermaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@streamdown/mermaid")>()),
  createMermaidPlugin: () => ({ getMermaid: () => ({ render: renderMermaid }) }),
}));

let MermaidBlock: typeof import("@/components/ai-elements/mermaid-block.js").MermaidBlock;
let MessageResponse: typeof import("@/components/ai-elements/message.js").MessageResponse;
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function tree(props: Parameters<typeof MermaidBlock>[0]) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(MermaidBlock, props),
  );
}

beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  MermaidBlock = (await import("@/components/ai-elements/mermaid-block.js")).MermaidBlock;
  MessageResponse = (await import("@/components/ai-elements/message.js")).MessageResponse;
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  renderMermaid.mockImplementation(async (id: string) => ({
    svg: `<svg id="${id}" viewBox="0 0 100 50"><path id="edge"/></svg>`,
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MermaidBlock 图表稳定性", () => {
  it("真实 Markdown 增量更新保留同一图表，未闭合语句失败不撤下最近成功图", async () => {
    vi.useFakeTimers();
    const response = (body: string) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(MessageResponse, { streaming: true, theme: "light" }, body),
        ),
      );
    const partial = "```mermaid\nflowchart TD\nOpenA-->OpenB\nOpenC-->OpenD\ntail";
    const view = render(response(partial));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const original = screen.getByRole("img").innerHTML;
    renderMermaid.mockRejectedValue(new Error("partial syntax"));
    view.rerender(response(`${partial}\nBroken(\nnext`));
    expect(screen.getByRole("img").innerHTML).toBe(original);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(screen.getByRole("img").innerHTML).toBe(original);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("整条消息尚未结束时，真实闭合的 Mermaid 围栏已完成图表渲染", async () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MessageResponse,
            { streaming: true, theme: "light" },
            "```mermaid\nflowchart TD\nClosedA-->ClosedB\n```\n\n消息还在继续",
          ),
        ),
      ),
    );
    await flush();
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(renderMermaid.mock.calls[0]?.[1]).toBe("flowchart TD\nClosedA-->ClosedB");
    expect(screen.getByRole("img")).toBeTruthy();
  });
  it("重新挂载同步显示缓存，不出现 loading，也不重复调用 Mermaid", async () => {
    const code = "flowchart TD\nMountA-->MountB";
    const first = render(tree({ code, theme: "light" }));
    await flush();
    expect(screen.getByRole("img")).toBeTruthy();
    first.unmount();
    render(tree({ code, theme: "light" }));
    expect(screen.getByRole("img")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    await flush();
    expect(renderMermaid).toHaveBeenCalledTimes(1);
  });

  it("内容更新保留已有图，半截失败不闪回源码，最终失败有提示与源码", async () => {
    vi.useFakeTimers();
    const good = "flowchart TD\nStableA-->StableB";
    const view = render(tree({ code: good, theme: "light" }));
    await flush();
    const original = screen.getByRole("img").innerHTML;
    renderMermaid.mockRejectedValue(new Error("bad syntax"));
    view.rerender(tree({ code: "flowchart TD\nBAD(\ntail", streaming: true, theme: "light" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(screen.getByRole("img").innerHTML).toBe(original);
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(tree({ code: "flowchart TD\nBAD(", streaming: false, theme: "light" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("无法解析");
    fireEvent.click(screen.getByText("查看源码"));
    expect(screen.getByRole("alert").querySelector("pre")?.textContent).toContain("BAD(");
    expect(screen.getByRole("img").innerHTML).toBe(original);
  });

  it("页面隐藏暂停新版本但保留当前图，恢复渲染最新源码", async () => {
    const view = render(tree({ code: "flowchart TD\nVisibleA-->VisibleB", theme: "light" }));
    await flush();
    const original = screen.getByRole("img").innerHTML;
    view.rerender(
      tree({ code: "flowchart TD\nResumedA-->ResumedB", theme: "light", renderEnabled: false }),
    );
    await flush();
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img").innerHTML).toBe(original);
    view.rerender(
      tree({ code: "flowchart TD\nResumedA-->ResumedB", theme: "light", renderEnabled: true }),
    );
    await flush();
    expect(renderMermaid).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img").innerHTML).not.toBe(original);
  });

  it("同源码两个实例只渲染一次，实例 SVG ID 各自隔离", async () => {
    const code = "flowchart TD\nTwinA-->TwinB";
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(MermaidBlock, { code, theme: "light" }),
        createElement(MermaidBlock, { code, theme: "light" }),
      ),
    );
    await flush();
    const diagrams = screen.getAllByRole("img");
    expect(diagrams).toHaveLength(2);
    expect(diagrams[0]?.querySelector("svg")?.id).not.toBe(diagrams[1]?.querySelector("svg")?.id);
    expect(diagrams[0]?.querySelector("path")?.id).not.toBe(diagrams[1]?.querySelector("path")?.id);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
  });

  it("主题与字体改变生成新配置，完成前保留旧图，切回直接命中缓存", async () => {
    const code = "flowchart TD\nThemeA-->ThemeB";
    const view = render(tree({ code, theme: "light", fontSizePx: 14 }));
    await flush();
    let finish!: (value: { svg: string }) => void;
    renderMermaid.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    view.rerender(tree({ code, theme: "dark", fontSizePx: 18 }));
    await flush();
    expect(screen.getByRole("img")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    finish({ svg: '<svg id="dark-svg"/>' });
    await flush();
    view.rerender(tree({ code, theme: "light", fontSizePx: 14 }));
    expect(screen.queryByRole("status")).toBeNull();
    await flush();
    expect(renderMermaid).toHaveBeenCalledTimes(2);
  });
});
