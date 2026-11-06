import { useRef, useState } from "react";
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, ListChecksIcon } from "lucide-react";
import type { NativePermissionOption, PlanState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 审批卡的应答：start=false 为继续修改；optionId 为界面选中的精确原生选项。 */
export interface NativePlanChoice {
  start: boolean;
  optionId?: string;
}

function isAllow(option: NativePermissionOption): boolean {
  return option.kind === "allow_once" || option.kind === "allow_always";
}

/**
 * 原生计划卡（docs/desktop/native-plan-errors-spec.md）：
 * - 审批模式（onResolve）：主按钮“开始执行”回传 Runtime 推荐的原生选项（保留上下文、回到进入计划前的模式），
 *   “更多”列出其余原生 allow 选项及原名并单独标注清空上下文项，“继续修改”回传 reject 选项。
 * - 无审批模式（onStart）：引擎写完计划却未请求审批时，只提供“开始执行”。
 */
export function NativePlanApprovalCard({
  markdown,
  items,
  workspacePath,
  autoFocus,
  nativeOptions,
  onResolve,
  onStart,
}: {
  markdown: string;
  items: PlanState["items"];
  workspacePath: string;
  autoFocus?: boolean;
  nativeOptions?: readonly NativePermissionOption[];
  onResolve?: (choice: NativePlanChoice) => Promise<boolean>;
  onStart?: () => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [responding, setResponding] = useState(false);
  const [failed, setFailed] = useState(false);
  const flight = useRef(false);
  const recommended = nativeOptions?.find((option) => option.recommended && isAllow(option));
  const rejectOption = nativeOptions?.find((option) => !isAllow(option));
  const moreOptions =
    nativeOptions?.filter(
      (option) => isAllow(option) && option.optionId !== recommended?.optionId,
    ) ?? [];
  const respond = async (choice: NativePlanChoice) => {
    // ACK 到达前保留静态计划卡并锁定所有按钮，双击不能创建第二次实施。
    if (flight.current) return;
    flight.current = true;
    setResponding(true);
    setFailed(false);
    const accepted = await (
      onResolve ? onResolve(choice) : choice.start && onStart ? onStart() : Promise.resolve(false)
    ).catch(() => false);
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
      data-plan-mode={onResolve ? "review" : "start"}
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
          {intl.formatMessage({
            id: onResolve ? "chat.permission.responseFailed" : "chat.nativePlan.startFailed",
          })}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {onResolve && moreOptions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                disabled={responding}
                data-testid="native-plan-more"
                className="gap-1"
              >
                {intl.formatMessage({ id: "chat.nativePlan.more" })}
                <ChevronDownIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-80">
              {moreOptions.map((option) => (
                <DropdownMenuItem
                  key={option.optionId}
                  data-testid={`native-plan-option-${option.optionId}`}
                  onSelect={() => void respond({ start: true, optionId: option.optionId })}
                  className="flex items-start justify-between gap-3"
                >
                  <span className="min-w-0 break-words">{option.label}</span>
                  {option.clearsContext ? (
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "chat.nativePlan.clearsContext" })}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {onResolve ? (
          <Button
            variant="outline"
            disabled={responding}
            onClick={() => void respond({ start: false, optionId: rejectOption?.optionId })}
            data-testid="native-plan-revise"
          >
            {intl.formatMessage({ id: "chat.nativePlan.revise" })}
          </Button>
        ) : null}
        <Button
          autoFocus={autoFocus}
          disabled={responding}
          onClick={() => void respond({ start: true, optionId: recommended?.optionId })}
          data-testid="native-plan-start"
        >
          {intl.formatMessage({ id: "chat.nativePlan.start" })}
        </Button>
      </div>
    </section>
  );
}
