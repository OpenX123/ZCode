import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import appLogoUrl from "@/assets/ycode-logo.png";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ZCodeStartupLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  return (
    <div
      data-desktop-logo-badge={size === "titlebar" ? "true" : undefined}
      className={cn("flex items-center justify-center", size === "titlebar" ? "size-5" : "size-24")}
    >
      {/* 原图自带底色与圆角，完整展示，避免重复底座缩小标志。 */}
      <ZCodeStartupLogo className="size-full" animated={animated} />
    </div>
  );
}

export function ZCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <img
      src={appLogoUrl}
      alt=""
      width="96"
      height="96"
      draggable={false}
      className={cn(
        "shrink-0 select-none object-contain",
        animated && "motion-safe:animate-pulse",
        className,
      )}
      aria-hidden="true"
    />
  );
}
