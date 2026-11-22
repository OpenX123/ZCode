import { describe, expect, it } from "vitest";
import type { TaskTitleSegment } from "@/reference-icons/contract.js";
import { getTaskTitleDisplayText, parseTaskTitleDisplay } from "@/reference-icons/index.js";

const options = {
  resolveSessionTitle: (taskId: string) =>
    ({ sess_8f2c: "Duobao Agent Server V3", sess_abc: "修复登录" })[taskId],
  fallbackLabels: { session: "引用的会话", image: "图片" },
};

const text = (label: string): TaskTitleSegment => ({ kind: "text", label });
const skill = (label: string): TaskTitleSegment => ({ kind: "skill", label });
const session = (label: string): TaskTitleSegment => ({
  kind: "session",
  label,
});
const file = (label: string): TaskTitleSegment => ({ kind: "file", label });
const url = (label: string): TaskTitleSegment => ({ kind: "url", label });
const image = (label: string): TaskTitleSegment => ({ kind: "image", label });

describe("parseTaskTitleDisplay", () => {
  it.each<[string, TaskTitleSegment[]]>([
    ["修复侧边栏标题的显示问题", [text("修复侧边栏标题的显示问题")]],
    ["  多个   空白\n折叠 ", [text("多个 空白 折叠")]],
    [
      "/fwq 连接一下我的相关云服务器为什么不行了",
      [skill("fwq"), text(" 连接一下我的相关云服务器为什么不行了")],
    ],
    ["$code-review 看下这个分支", [skill("code-review"), text(" 看下这个分支")]],
    [
      "[$Code Review](/Users/me/.agents/skills/code-review/SKILL.md) 帮我",
      [skill("Code Review"), text(" 帮我")],
    ],
    ["价格 $100 和 a/b 测试", [text("价格 $100 和 a/b 测试")]],
    ["请看 /fwq 的用法", [text("请看 /fwq 的用法")]],
    ["[#修复登录](#sess_abc) 继续", [session("修复登录"), text(" 继续")]],
    ["接着 #sess_abc 做", [text("接着 "), session("修复登录"), text(" 做")]],
    ["#sess_unknown 继续", [session("引用的会话"), text(" 继续")]],
    [
      "zcode://session/open?taskId=sess_8f2c&path=C%3A%5CUsers%5Cme",
      [session("Duobao Agent Server V3")],
    ],
    [
      "ycode://session/open?taskId=sess_8f2c&path=C:\\Users\\me\\proj 看下",
      [session("Duobao Agent Server V3"), text(" 看下")],
    ],
    [
      "zcode://session/open?taskId=sess_8f2c&pa...",
      [session("Duobao Agent Server V3"), text("...")],
    ],
    ["zcode://session/open?tas...", [session("引用的会话"), text("...")]],
    ["打开zcode://session/open?taskId=sess_abc", [text("打开"), session("修复登录")]],
    [
      "C:\\Users\\me\\personal-skills\\docs\\reports\\sub2api-2026-11-19.html 打不开",
      [file("sub2api-2026-11-19.html"), text(" 打不开")],
    ],
    ["D:/work/repo/src/main.ts，报错", [file("main.ts"), text("，报错")]],
    ["C:\\a\\b.html打不开", [file("b.html"), text("打不开")]],
    ["\\\\server\\share\\报表.xlsx 打不开", [file("报表.xlsx"), text(" 打不开")]],
    ["看 /Users/me/project/README.md 第三段", [text("看 "), file("README.md"), text(" 第三段")]],
    ["~/Desktop/notes.txt 整理", [file("notes.txt"), text(" 整理")]],
    ["./src/components/Button.tsx 改样式", [file("Button.tsx"), text(" 改样式")]],
    [
      "C:\\Users\\me\\docs\\reports\\sub2api-2026-11-19.ht...",
      [file("sub2api-2026-11-19.ht"), text("...")],
    ],
    ["[Button.tsx](./src/components/Button.tsx) 改样式", [file("Button.tsx"), text(" 改样式")]],
    ["[components/](./src/components/) 整理", [file("components"), text(" 整理")]],
    ["[@插件创建器](plugin://plugin-creator@official) 做个插件", [text("插件创建器 做个插件")]],
    ["https://sub.artai.top/admin/groups 报 502", [url("sub.artai.top"), text(" 报 502")]],
    ["看下https://example.com/a?b=1。", [text("看下"), url("example.com"), text("。")]],
    [
      "https://user@git.example.com:8443/x 拉不下来",
      [url("git.example.com:8443"), text(" 拉不下来")],
    ],
    ["[文档](https://docs.example.com/a) 里说的", [url("文档"), text(" 里说的")]],
    ["https://sub.artai.top/admin/gro...", [url("sub.artai.top"), text("...")]],
    ["file:///C:/Users/me/a%20b.pdf 打不开", [file("a b.pdf"), text(" 打不开")]],
    ["[image] 这个报错什么意思", [image("图片"), text(" 这个报错什么意思")]],
    ["[Image #2] 对比一下", [image("图片"), text(" 对比一下")]],
    ["C:\\Users\\me\\Pictures\\shot.PNG 里的报错", [image("shot.PNG"), text(" 里的报错")]],
    ["看下 ~/Desktop/shot.png", [text("看下 "), image("shot.png")]],
    ["[截图.jpg](./assets/截图.jpg)", [image("截图.jpg")]],
  ])("%s", (title, expected) => {
    expect(parseTaskTitleDisplay(title, options)).toEqual(expected);
  });

  it("无 resolver 时会话使用默认英文 fallback", () => {
    expect(parseTaskTitleDisplay("#sess_abc")).toEqual([session("Referenced session")]);
    expect(parseTaskTitleDisplay("[image]")).toEqual([image("Image")]);
  });

  it("可读文本不含原始路径", () => {
    const segments = parseTaskTitleDisplay(
      "C:\\Users\\me\\docs\\a.html 和 https://x.example.com/p 对比",
      options,
    );
    expect(getTaskTitleDisplayText(segments)).toBe("a.html 和 x.example.com 对比");
  });

  it("空白标题回退原文", () => {
    expect(parseTaskTitleDisplay("   ")).toEqual([text("   ")]);
  });
});
