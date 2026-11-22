import { cn } from "@/components/lib/utils.js";

/**
 * 技能来源小标（YCode / Claude / Codex / Agents / 插件名）。
 * 默认 `rounded-md` 用于设置卡片内；菜单选项内传 `rounded-sm`（DESIGN.md Radius）。
 */
export function SkillSourceBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      data-skill-source-badge="true"
      className={cn(
        "inline-flex h-4 max-w-32 shrink-0 items-center truncate rounded-md border border-border px-1 text-ui-xs text-foreground-subtle",
        className,
      )}
      title={label}
    >
      {label}
    </span>
  );
}
