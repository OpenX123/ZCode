import { useRef, useState } from "react";
import { CheckCircle2Icon, CircleIcon, ListChecksIcon } from "lucide-react";
import type { PlanState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function NativePlanApprovalCard({
  markdown,
  items,
  workspacePath,
  autoFocus,
  onResolve,
}: {
  markdown: string;
  items: PlanState["items"];
  workspacePath: string;
  autoFocus?: boolean;
  onResolve: (start: boolean) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [responding, setResponding] = useState(false);
  const [failed, setFailed] = useState(false);
  const flight = useRef(false);
  const respond = async (start: boolean) => {
    // ACK 到达前保留静态计划卡并锁定两个按钮，双击不能创建第二次实施。
    if (flight.current) return;
    flight.current = true;
    setResponding(true);
    setFailed(false);
    const accepted = await onResolve(start).catch(() => false);
    if (!accepted) {
      flight.current = false;
      setResponding(false);
      setFailed(true);
    }
  };
  return (
    <section
      className="mx-3 mb-3 min-w-0 rounded-xl border border-border bg-card p-4"
      aria-label={intl.formatMessage({ id: "chat.nativePlan.ready" })}
      data-testid="native-plan-approval"
    >
      <div className="mb-3 flex items-center gap-2 text-ui-base font-medium">
        <ListChecksIcon className="size-4 text-foreground-subtle" />
        {intl.formatMessage({ id: "chat.nativePlan.ready" })}
      </div>
      <div className="max-h-[min(50dvh,36rem)] min-w-0 overflow-y-auto overscroll-contain">
        {items.length > 0 ? (
          <ul className="mb-4 space-y-2" data-testid="native-plan-checklist">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-ui-base">
                {item.status === "completed" ? (
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                ) : (
                  <CircleIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                )}
                <span>{item.content}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {markdown ? (
          <MessageResponse streaming={false} workspacePath={workspacePath}>
            {markdown}
          </MessageResponse>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="mt-3 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "chat.permission.responseFailed" })}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          disabled={responding}
          onClick={() => void respond(false)}
          data-testid="native-plan-revise"
        >
          {intl.formatMessage({ id: "chat.nativePlan.revise" })}
        </Button>
        <Button
          autoFocus={autoFocus}
          disabled={responding}
          onClick={() => void respond(true)}
          data-testid="native-plan-start"
        >
          {intl.formatMessage({ id: "chat.nativePlan.start" })}
        </Button>
      </div>
    </section>
  );
}
