import { ZCodeAppLogo } from "@/components/mobile-ui/index.js";
import { cn } from "@/components/lib/utils.js";
import type { TaskClientLogoProps } from "./contract.js";
import codexLogo from "./assets/openai.svg";
import claudeCodeLogo from "./assets/claude-color.svg";

export function TaskClientLogo({ engine = "zcode" }: TaskClientLogoProps) {
  const label = engine === "zcode" ? "YCode" : engine === "codex" ? "Codex" : "Claude Code";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-task-client-logo={engine}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      {engine === "zcode" ? (
        <ZCodeAppLogo className="size-4" />
      ) : (
        <img
          src={engine === "codex" ? codexLogo : claudeCodeLogo}
          alt=""
          aria-hidden="true"
          draggable={false}
          width={16}
          height={16}
          className={cn(
            "size-4 select-none object-contain",
            engine === "codex" && "[.dark_&]:invert",
          )}
        />
      )}
    </span>
  );
}
