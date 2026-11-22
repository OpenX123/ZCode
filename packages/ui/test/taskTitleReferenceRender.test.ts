// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskTitleDisplay, TaskTitleLookupProvider } from "@/reference-icons/index.js";
import { decoratePromptMention } from "@/mentions/nodes/promptMentionDecoration.js";

const fallbackLabels = { session: "引用的会话", image: "图片" };

function renderTitle(title: string, tasks: Array<{ taskId: string; title: string }> = []) {
  return renderToStaticMarkup(
    createElement(
      TaskTitleLookupProvider,
      { tasks },
      createElement(TaskTitleDisplay, { title, fallbackLabels }),
    ),
  );
}

describe("TaskTitleDisplay", () => {
  it("路径显示为文件图标 + 文件名，不输出原始路径", () => {
    const html = renderTitle("C:\\Users\\me\\docs\\report.html 打不开");
    expect(html).toContain('data-reference-icon="file"');
    expect(html).toContain("report.html");
    expect(html).toContain(" 打不开");
    expect(html).not.toContain("Users");
  });

  it("引用会话从任务列表查标题，查不到用 fallback", () => {
    const deepLink = "zcode://session/open?taskId=sess_1&path=%2Ftmp";
    expect(
      renderTitle(deepLink, [{ taskId: "sess_1", title: "Duobao Agent Server V3" }]),
    ).toContain("Duobao Agent Server V3");
    const fallback = renderTitle(deepLink);
    expect(fallback).toContain('data-reference-icon="session"');
    expect(fallback).toContain("引用的会话");
    expect(fallback).not.toContain("zcode://");
  });

  it("普通标题不渲染图标", () => {
    expect(renderTitle("修复侧边栏")).not.toContain("data-reference-icon");
  });
});

describe("输入框 chip 引用图标", () => {
  it.each(["skills", "sessions"] as const)("%s 使用 16×16 引用图标遮罩", (category) => {
    const dom = document.createElement("span");
    decoratePromptMention(dom, category, "value");
    const mask = decodeURIComponent(dom.style.getPropertyValue("--mention-mask"));
    expect(mask).toContain('viewBox="0 0 16 16"');
  });

  it("subagent 等其他类别仍使用 lucide 24×24 画布", () => {
    const dom = document.createElement("span");
    decoratePromptMention(dom, "subagents", "reviewer");
    expect(decodeURIComponent(dom.style.getPropertyValue("--mention-mask"))).toContain(
      'viewBox="0 0 24 24"',
    );
  });
});
