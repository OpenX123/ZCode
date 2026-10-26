import { EXTERNAL_ENGINE_RUNTIMES } from "@zcode/shared/external-engine";
import { useState } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { ENGINE_LABELS, type EngineControlsProps } from "./contract.js";
import {
  EngineConfigMenu,
  EngineEffortPicker,
  engineTriggerClassName,
} from "./EngineConfigPicker.js";

export function EngineControls({
  engine,
  onSelectEngine,
  options = [],
  onConfigChange,
  disabled,
  loading,
  error,
  connectionFailure,
  onRetry,
}: EngineControlsProps) {
  const { intl } = useZCodeIntl();
  const failureMessage = connectionFailure
    ? intl.formatMessage(
        { id: `engine.failure.${connectionFailure.code}` },
        {
          command:
            engine === "zcode" ? "" : EXTERNAL_ENGINE_RUNTIMES[engine].loginCommand.join(" "),
        },
      )
    : error;
  const diagnostic = connectionFailure?.method
    ? ` (${connectionFailure.method}${connectionFailure.rpcCode !== undefined ? `, RPC ${connectionFailure.rpcCode}` : ""})`
    : "";
  const [activePicker, setActivePicker] = useState<string | null>(null);
  const model = options.find((option) => option.id === "model");
  const modelLabel = model?.options.find((entry) => entry.value === model.currentValue)?.name;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="external-engine-controls"
    >
      {onSelectEngine ? (
        <Select
          value={engine}
          onValueChange={onSelectEngine}
          disabled={disabled}
          open={activePicker === "engine"}
          onOpenChange={(open) =>
            setActivePicker((current) => (open ? "engine" : current === "engine" ? null : current))
          }
        >
          <SelectTrigger
            variant="ghost"
            className={engineTriggerClassName}
            aria-label={intl.formatMessage({ id: "engine.select" })}
            data-testid="session-engine-select"
            data-composer-collapse-priority="3"
            indicator={
              <ChevronDownIcon className="size-3.5 text-foreground-subtle group-data-[composer-compact=true]/engine-option:hidden" />
            }
          >
            <BotIcon className="hidden size-4 group-data-[composer-compact=true]/engine-option:block" />
            <span className="group-data-[composer-compact=true]/engine-option:hidden">
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent
            position="popper"
            side="top"
            sideOffset={8}
            onCloseAutoFocus={(event) => {
              if (activePicker !== null && activePicker !== "engine") event.preventDefault();
            }}
          >
            {Object.entries(ENGINE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span
          className="px-2 text-ui-sm text-foreground-subtle data-[composer-compact=true]:hidden"
          data-testid="session-engine-label"
          data-composer-collapse-priority="3"
        >
          {ENGINE_LABELS[engine]}
        </span>
      )}
      {loading ? (
        <span role="status" className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "engine.connecting" })}
        </span>
      ) : null}
      {failureMessage ? (
        <span role="alert" className="px-2 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "engine.connectionFailed" })}: {failureMessage}
          {diagnostic}
          {onRetry ? (
            <button
              type="button"
              className="ml-2 underline"
              onClick={onRetry}
              disabled={loading || disabled}
            >
              {intl.formatMessage({ id: "engine.retryConnection" })}
            </button>
          ) : null}
        </span>
      ) : null}
      {options.map((option) => {
        const picker = `config:${option.id}`;
        const props = {
          option,
          disabled: disabled || loading || Boolean(failureMessage) || !onConfigChange,
          open: activePicker === picker,
          restoreFocus: activePicker === null || activePicker === picker,
          onOpenChange: (open: boolean) =>
            setActivePicker((current) => (open ? picker : current === picker ? null : current)),
          onValueChange: (value: string) => onConfigChange?.(option.id, value),
        };
        return ["effort", "reasoningeffort", "thoughtlevel"].includes(
          option.id.replace(/[-_]/g, "").toLowerCase(),
        ) ? (
          <EngineEffortPicker key={option.id} {...props} modelLabel={modelLabel} />
        ) : (
          <EngineConfigMenu key={option.id} {...props} />
        );
      })}
    </div>
  );
}
