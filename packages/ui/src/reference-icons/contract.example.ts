import type { ParseTaskTitleDisplayOptions } from "./contract.js";

/** 首条输入以 Windows 路径开头的任务标题。 */
export const windowsPathTitleExample =
  "C:\\Users\\me\\personal-skills\\docs\\reports\\sub2api-2026-11-19.html 打不开";

/** 被 60 字符截断的会话深链标题（CLI `titleFromInput` 末尾补 `...`）。 */
export const truncatedDeepLinkTitleExample = "zcode://session/open?tas...";

/** 列表中可查到被引用会话标题的解析选项。 */
export const sessionLookupOptionsExample = {
  resolveSessionTitle: (taskId: string) =>
    taskId === "sess_8f2c" ? "Duobao Agent Server V3" : undefined,
  fallbackLabels: { session: "引用的会话", image: "图片" },
} satisfies ParseTaskTitleDisplayOptions;
