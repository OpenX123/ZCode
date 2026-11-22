import type { ReferenceIconKind, ReferenceIconNode } from "./contract.js";

/** 统一规格：16×16 画布、1.5 线宽、圆端点圆角、无填充、currentColor。 */
export const REFERENCE_ICON_VIEW_BOX = "0 0 16 16";
export const REFERENCE_ICON_STROKE_WIDTH = "1.5";

// 路径数据与已确认的设计稿（侧边栏引用图标稿）逐字一致，修改前需同步设计稿。
export const REFERENCE_ICON_NODES = {
  // 四角星 + 右上小加号
  skill: [
    [
      "path",
      {
        d: "M7 3.2c.4 2.6 1.9 4.1 4.5 4.5-2.6.4-4.1 1.9-4.5 4.5-.4-2.6-1.9-4.1-4.5-4.5 2.6-.4 4.1-1.9 4.5-4.5Z",
      },
    ],
    ["path", { d: "M12.5 1.8v2.4M11.3 3h2.4" }],
  ],
  // 对话气泡 + 右上外链箭头
  session: [
    [
      "path",
      {
        d: "M3.5 5h5.5a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H6.2L4 13.2v-1.7h-.5A1.5 1.5 0 0 1 2 10V6.5A1.5 1.5 0 0 1 3.5 5Z",
      },
    ],
    ["path", { d: "M10.5 2.5h3v3M13.5 2.5l-3.2 3.2" }],
  ],
  // 折角文档
  file: [
    [
      "path",
      {
        d: "M4.5 2h4.6L12 4.9V13a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z",
      },
    ],
    ["path", { d: "M9 2v3h3" }],
  ],
  // 地球
  url: [
    ["circle", { cx: "8", cy: "8", r: "5.75" }],
    ["path", { d: "M2.5 8h11" }],
    [
      "path",
      {
        d: "M8 2.3c1.5 1.6 2.3 3.5 2.3 5.7s-.8 4.1-2.3 5.7c-1.5-1.6-2.3-3.5-2.3-5.7S6.5 3.9 8 2.3Z",
      },
    ],
  ],
  // 带框图片
  image: [
    ["rect", { x: "2.25", y: "2.75", width: "11.5", height: "10.5", rx: "1.75" }],
    ["circle", { cx: "5.75", cy: "6.25", r: "1.1" }],
    ["path", { d: "m2.75 12 3.5-3.5 2.5 2.5 1.75-1.75 2.75 2.75" }],
  ],
} as const satisfies Record<ReferenceIconKind, ReferenceIconNode>;
