import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

describe("RootStartupLoading", () => {
  it("静态品牌图标不渲染呼吸动画", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain("<img");
    expect(html).not.toContain("animate-pulse");
  });
  it("启动阻塞态显示 YCode 原始图片并保留无障碍状态", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<img");
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).toContain("ycode-logo.png");
    expect(html).not.toContain(">加载中...<");
  });
});
