import { BotIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SubagentActivityButtonProps } from "./contract.js";

/** 常驻入口只派生展示，不建立另一份子任务运行状态。 */
export function SubagentActivityButton({ subagents, onOpen }: SubagentActivityButtonProps) {
  const { intl } = useZCodeIntl();
  const total = subagents.childSessionIds.length;
  if (total === 0) return null;
  const states = (["running", "waiting", "blocked"] as const).flatMap((status) => {
    const count = subagents.running.filter((item) => item.status === status).length;
    return count > 0
      ? [`${intl.formatMessage({ id: `subagentDisplay.status.${status}` })} ${count}`]
      : [];
  });
  const label = [
    intl.formatMessage({ id: "subagentDisplay.activity.total" }, { count: String(total) }),
    ...states,
    subagents.endedTotal > 0
      ? intl.formatMessage(
          { id: "subagentDisplay.activity.ended" },
          { count: String(subagents.endedTotal) },
        )
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const running = subagents.running.some((item) => item.status === "running");
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="subagent-activity-trigger"
      data-running-count={subagents.running.length}
      aria-label={label}
      title={label}
      onClick={onOpen}
      className="min-w-0 max-w-64 shrink px-1.5 text-ui-sm text-foreground-subtle"
    >
      {running ? (
        <LoaderIcon
          aria-hidden
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
      ) : (
        <BotIcon aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </Button>
  );
}
