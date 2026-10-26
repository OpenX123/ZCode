import { ZCodeAppLogo } from "@/components/mobile-ui/index.js";
import { cn } from "@/components/lib/utils.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <ZCodeAppLogo className={cn("size-24", className)} />
  );
}
