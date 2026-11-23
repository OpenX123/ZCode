/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);

function renderMarkdown(markdown: string, streaming = false): HTMLElement {
  const view = render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(MessageResponse, { theme: "light", streaming }, markdown),
      ),
    ),
  );
  return view.container;
}

describe("加粗包裹裸 URL（真实 Streamdown 渲染）", () => {
  it.each([
    ["Swagger 地址是 **http://127.0.0.1:21500/docs**。", "http://127.0.0.1:21500/docs", "。"],
    ["**http://x.test/a**，后文", "http://x.test/a", "，后文"],
    ["（**https://example.com/p**）", "https://example.com/p", "）"],
    // 链接经 Streamdown URL 规范化后会补出根路径 `/`。
    ["**www.example.com**。", "http://www.example.com/", "。"],
    ["**http://a.test/x** 后文", "http://a.test/x", " 后文"],
  ])("%s", (markdown, href, after) => {
    for (const streaming of [false, true]) {
      const container = renderMarkdown(markdown, streaming);
      const link = container.querySelector("strong [title]");
      expect(link?.getAttribute("title")).toBe(href);
      expect(container.textContent).not.toContain("**");
      expect(container.textContent?.endsWith(after)).toBe(true);
      cleanup();
    }
  });

  it.each(["地址 **http://127.0.0.1:21500/do", "地址 **http://127.0.0.1:21500/docs**"])(
    "流式中间态不露出 **：%s",
    (markdown) => {
      const container = renderMarkdown(markdown, true);
      expect(container.textContent).not.toContain("**");
      expect(container.querySelector("strong [title]")?.getAttribute("title")).toMatch(
        /^http:\/\/127\.0\.0\.1:21500\/do/,
      );
    },
  );

  it.each([
    ["这是**加粗：**文字", "加粗："],
    ["**“引用”**的说明", "“引用”"],
    ["**Title**\n\nBody", "Title"],
  ])("CJK 加粗保持正确：%s", (markdown, strongText) => {
    const container = renderMarkdown(markdown);
    expect(container.textContent).not.toContain("**");
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe(strongText);
  });

  it("普通链接与行内代码不受影响", () => {
    const container = renderMarkdown("[文档](http://a.test/x) 与 `http://a.test/x**`。");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("http://a.test/x");
    expect(container.querySelector("code")?.textContent).toBe("http://a.test/x**");
  });
});
