import { useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TaskTitleDisplayProps } from "./contract.js";
import { ReferenceIcon } from "./ReferenceIcon.js";
import { parseTaskTitleDisplay } from "./parseTaskTitle.js";
import { useTaskTitleLookup } from "./TaskTitleLookup.js";

/**
 * 侧边栏任务标题：技能、引用会话、路径、网址、图片显示为「图标 + 简短名称」。
 * 只改显示；外层单行溢出（渐隐/走马灯）仍由 TaskTitleOverflowText 负责。
 */
export function TaskTitleDisplay({ title, fallbackLabels, iconClassName }: TaskTitleDisplayProps) {
  const lookup = useTaskTitleLookup();
  const segments = useMemo(
    () =>
      parseTaskTitleDisplay(title, {
        fallbackLabels,
        ...(lookup ? { resolveSessionTitle: lookup } : {}),
      }),
    [fallbackLabels, lookup, title],
  );
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.label}</span>
        ) : (
          <span
            key={index}
            data-task-title-reference={segment.kind}
            className="inline-flex items-center gap-1 align-bottom"
          >
            <ReferenceIcon
              kind={segment.kind}
              size={14}
              className={cn("text-foreground-subtle", iconClassName)}
            />
            <span>{segment.label}</span>
          </span>
        ),
      )}
    </>
  );
}
