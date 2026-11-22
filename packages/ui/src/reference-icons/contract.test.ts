import { describe, expect, it } from "vitest";
import {
  sessionLookupOptionsExample,
  truncatedDeepLinkTitleExample,
  windowsPathTitleExample,
} from "./contract.example.js";
import { getTaskTitleDisplayText, parseTaskTitleDisplay } from "./parseTaskTitle.js";
import { REFERENCE_ICON_NODES } from "./icons.js";

describe("reference-icons 合同", () => {
  it("Windows 路径只显示文件名，正文保留", () => {
    expect(parseTaskTitleDisplay(windowsPathTitleExample)).toEqual([
      { kind: "file", label: "sub2api-2026-11-19.html" },
      { kind: "text", label: " 打不开" },
    ]);
  });

  it("截断的深链仍识别为引用会话并使用 fallback 文案", () => {
    const segments = parseTaskTitleDisplay(
      truncatedDeepLinkTitleExample,
      sessionLookupOptionsExample,
    );
    expect(segments).toEqual([
      { kind: "session", label: "引用的会话" },
      { kind: "text", label: "..." },
    ]);
    expect(getTaskTitleDisplayText(segments)).toBe("引用的会话...");
  });

  it("五个图标都有绘制数据", () => {
    expect(Object.keys(REFERENCE_ICON_NODES).sort()).toEqual([
      "file",
      "image",
      "session",
      "skill",
      "url",
    ]);
  });
});
