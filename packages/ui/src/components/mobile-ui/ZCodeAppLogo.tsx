import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";
import appLogoUrl from "@/assets/ycode-logo.png";

/**
 * 应用内共用透明底 Y 字形；浅色为黑色、深色为白色。
 * 装饰性图片：调用方负责在旁边给出可读的品牌文字，避免屏幕阅读器重复朗读。
 */
export function ZCodeAppLogo({ className }: ZCodeAppLogoProps) {
  return (
    <img
      src={appLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      // 稳定的测试/E2E 钩子：打包器可能把 SVG 内联为 data URL，不能靠文件名断言。
      data-app-logo="zcode"
      // 主题由应用根节点决定；Tailwind 默认 dark variant 跟随系统，无法响应应用内独立切换。
      className={cn("shrink-0 select-none object-contain brightness-0 [.dark_&]:invert", className)}
    />
  );
}
