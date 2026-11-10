import { ZCodeAppLogo } from "@/components/mobile-ui/index.js";
import { cn } from "@/components/lib/utils.js";
import { ENGINE_LABELS, type TaskClientLogoProps } from "./contract.js";
import codexLogo from "./assets/openai.svg";
import claudeCodeLogo from "./assets/claude-color.svg";

export function TaskClientLogo({ engine = "zcode", size = "default" }: TaskClientLogoProps) {
  // 显示名统一取自 ENGINE_LABELS，避免与引擎切换行、设置页出现 ZCode/YCode 两套名字。
  const label = ENGINE_LABELS[engine];
  const sizeClassName = size === "compact" ? "size-3.5" : "size-4";
  const pixels = size === "compact" ? 14 : 16;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-task-client-logo={engine}
      className={cn("inline-flex shrink-0 items-center justify-center", sizeClassName)}
    >
      {engine === "zcode" ? (
        <ZCodeAppLogo className={sizeClassName} />
      ) : (
        <img
          src={engine === "codex" ? codexLogo : claudeCodeLogo}
          alt=""
          aria-hidden="true"
          draggable={false}
          width={pixels}
          height={pixels}
          className={cn(
            sizeClassName,
            "select-none object-contain",
            engine === "codex" && "[.dark_&]:invert",
          )}
        />
      )}
    </span>
  );
}
