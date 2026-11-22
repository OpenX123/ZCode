import { cn } from "@/components/lib/utils.js";
import type { ReferenceIconProps } from "./contract.js";
import {
  REFERENCE_ICON_NODES,
  REFERENCE_ICON_STROKE_WIDTH,
  REFERENCE_ICON_VIEW_BOX,
} from "./icons.js";

export function ReferenceIcon({ kind, size = 16, className, ...props }: ReferenceIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={REFERENCE_ICON_VIEW_BOX}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={REFERENCE_ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-reference-icon={kind}
      // 复用 `svg.lucide[stroke=currentColor]` 的前景层级适配（DESIGN.md「Lucide 前景透明度」），
      // 会话图标的路径有交点，需与 lucide 图标一样先不透明绘制再整体合成。
      className={cn("lucide shrink-0", className)}
      {...props}
    >
      {REFERENCE_ICON_NODES[kind].map(([tagName, attributes], index) => {
        const Tag = tagName;
        return <Tag key={index} {...attributes} />;
      })}
    </svg>
  );
}
