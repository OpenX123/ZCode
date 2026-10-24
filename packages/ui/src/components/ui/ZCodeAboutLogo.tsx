import appLogoUrl from "@/assets/ycode-logo.png";
import { cn } from "@/components/lib/utils.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img
      src={appLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      width="96"
      height="96"
      className={cn("shrink-0 select-none object-contain", className)}
    />
  );
}
