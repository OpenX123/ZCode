import {
  EXTERNAL_ENGINE_RUNTIMES,
  engineConfigOptionKind,
  isExternalSessionEngine,
  type SessionEngine,
} from "@zcode/shared/external-engine";
import { useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ENGINE_LABELS, type EngineControlsProps } from "./contract.js";
import { TaskClientLogo } from "./TaskClientLogo.js";
import { ErrorDiagnostics } from "@/components/ai-elements/error-diagnostics.js";
import {
  EngineConfigMenu,
  EngineEffortPicker,
  engineTriggerClassName,
} from "./EngineConfigPicker.js";

export function EngineControls({
  engine,
  placement,
  onSelectEngine,
  options = [],
  onConfigChange,
  disabled,
  loading,
  configPending,
  error,
  connectionFailure,
  onRetry,
  externalEngineUnavailableReason,
  renderLayout,
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
  const diagnostic = connectionFailure ? JSON.stringify(connectionFailure, null, 2) : "";
  const methodSummary = connectionFailure?.method
    ? ` (${connectionFailure.method}${connectionFailure.rpcCode !== undefined ? `, RPC ${connectionFailure.rpcCode}` : ""})`
    : "";
  const [activePicker, setActivePicker] = useState<string | null>(null);
  const unavailableReasonId = useId();
  const model = options.find((option) => option.id === "model");
  const modelLabel = model?.options.find((entry) => entry.value === model.currentValue)?.name;
  const selector = onSelectEngine ? (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <div
        role="group"
        aria-label={intl.formatMessage({ id: "engine.select" })}
        aria-describedby={externalEngineUnavailableReason ? unavailableReasonId : undefined}
        data-testid="session-engine-select"
        className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1"
      >
        {Object.entries(ENGINE_LABELS).map(([value, label]) => {
          const unavailable =
            Boolean(externalEngineUnavailableReason) &&
            isExternalSessionEngine(value as SessionEngine);
          return (
            <Button
              key={value}
              type="button"
              variant="ghost"
              aria-label={label}
              aria-pressed={engine === value}
              aria-describedby={unavailable ? unavailableReasonId : undefined}
              title={unavailable ? `${label}: ${externalEngineUnavailableReason}` : label}
              disabled={disabled || unavailable}
              data-testid={`session-engine-option-${value}`}
              className={`h-7 gap-1.5 rounded-full px-2 text-ui-sm ${engine === value ? "bg-selected text-foreground" : "text-foreground-subtle"}`}
              onClick={() => onSelectEngine(value as SessionEngine)}
            >
              <TaskClientLogo engine={value as SessionEngine} />
              {engine === value ? <span>{label}</span> : null}
            </Button>
          );
        })}
      </div>
      {externalEngineUnavailableReason ? (
        <p id={unavailableReasonId} className="text-ui-sm text-foreground-subtle">
          {externalEngineUnavailableReason}
        </p>
      ) : null}
    </div>
  ) : null;
  const indicator = !onSelectEngine ? (
    <span
      className="inline-flex size-7 shrink-0 items-center justify-center grayscale opacity-60"
      data-testid="session-engine-indicator"
    >
      <TaskClientLogo engine={engine} />
    </span>
  ) : null;
  if (placement === "selector") return selector ?? indicator;
  const fastIds = new Set(["fast", "fast_mode", "speed", "service_tier"]);
  const primary = options.filter((option) => !fastIds.has(option.id.toLowerCase()));
  const more = options.filter((option) => fastIds.has(option.id.toLowerCase()));
  const renderOption = (option: (typeof options)[number]) => {
    const picker = `config:${option.id}`;
    const props = {
      option,
      disabled: disabled || loading || configPending || Boolean(failureMessage) || !onConfigChange,
      open: activePicker === picker,
      restoreFocus:
        (engineConfigOptionKind(option.id) === "other" || (!effort && more.length === 0)) &&
        (activePicker === null || activePicker === picker),
      onOpenChange: (open: boolean) =>
        setActivePicker((current) => (open ? picker : current === picker ? null : current)),
      onValueChange: (value: string) => onConfigChange?.(option.id, value),
    };
    return engineConfigOptionKind(option.id) === "effort" ? (
      <EngineEffortPicker key={option.id} {...props} modelLabel={modelLabel} />
    ) : (
      <EngineConfigMenu key={option.id} {...props} />
    );
  };
  const effort = primary.find((option) => engineConfigOptionKind(option.id) === "effort");
  const moreControls = more.length ? (
    <details data-testid="engine-more-options" className="w-full border-t border-border pt-2">
      <summary className="cursor-pointer text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.moreOptions" })}
      </summary>
      <div className="pt-1">
        {more.map((option) => (
          <div key={option.id} className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-ui-sm">{option.name}</span>
            {renderOption(option)}
          </div>
        ))}
      </div>
    </details>
  ) : null;
  const effortPicker = effort ? `config:${effort.id}` : "model-effort";
  const combinedOpen =
    activePicker === effortPicker ||
    more.some((option) => activePicker === `config:${option.id}`) ||
    Boolean(model && activePicker === "config:model");
  const modelControls = effort ? (
    <EngineEffortPicker
      option={effort}
      disabled={disabled || loading || configPending || Boolean(failureMessage) || !onConfigChange}
      open={combinedOpen}
      // 旧弹层退出动画完成时不能抢回新权限菜单的焦点；只在本簇关闭时回焦。
      restoreFocus={activePicker === null || combinedOpen}
      onOpenChange={(open) => setActivePicker(open ? effortPicker : null)}
      onValueChange={(value) => onConfigChange?.(effort.id, value)}
      modelLabel={modelLabel ?? model?.currentValue}
      modelControl={model ? renderOption(model) : undefined}
      triggerLabel={
        model
          ? `${modelLabel ?? model.currentValue} · ${effort.options.find((entry) => entry.value === effort.currentValue)?.name ?? effort.currentValue}`
          : undefined
      }
      moreControls={moreControls}
    />
  ) : model && !more.length ? (
    renderOption(model)
  ) : more.length ? (
    <Popover
      open={combinedOpen}
      onOpenChange={(open) => setActivePicker(open ? effortPicker : null)}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={engineTriggerClassName}
          data-testid="engine-config-model-effort"
          disabled={disabled || loading || configPending || Boolean(failureMessage)}
        >
          {modelLabel ?? intl.formatMessage({ id: "engine.moreOptions" })}
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 max-w-[calc(100vw-1.5rem)]">
        {model ? renderOption(model) : null}
        {moreControls}
      </PopoverContent>
    </Popover>
  ) : null;
  const leadingActions = (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="external-engine-controls"
    >
      {primary.filter((option) => engineConfigOptionKind(option.id) === "other").map(renderOption)}
      {loading ? (
        <span role="status" className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "engine.connecting" })}
        </span>
      ) : null}
      {failureMessage ? (
        <div role="alert" className="min-w-0 px-2 text-ui-sm text-destructive">
          {intl.formatMessage({
            id:
              connectionFailure?.code === "provider"
                ? "engine.requestFailed"
                : "engine.connectionFailed",
          })}
          : {failureMessage}
          {connectionFailure?.httpStatus ? ` · HTTP ${connectionFailure.httpStatus}` : ""}
          {methodSummary}
          {connectionFailure?.message ? (
            <p className="select-text break-words">{connectionFailure.message}</p>
          ) : null}
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
          {diagnostic ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" className="h-7 px-2 text-ui-sm">
                  {intl.formatMessage({ id: "engine.errorDetails" })}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="w-80 max-w-[calc(100vw-1.5rem)]"
                data-testid="engine-error-details"
              >
                <ErrorDiagnostics
                  text={diagnostic}
                  label={intl.formatMessage({ id: "engine.errorDetails" })}
                  copyLabel={intl.formatMessage({ id: "engine.copyErrorDetails" })}
                />
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  return renderLayout ? (
    renderLayout({ leadingActions, modelControls })
  ) : (
    <>
      {placement !== "toolbar" ? (selector ?? indicator) : null}
      <div className="flex min-w-0 items-center gap-1" data-testid="external-engine-toolbar">
        {leadingActions}
        {modelControls}
      </div>
    </>
  );
}
