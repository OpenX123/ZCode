import { EXTERNAL_ENGINE_RUNTIMES } from "@zcode/shared/external-engine";
import { useState } from "react";
import { BotIcon, ChevronDownIcon, PlugIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
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
  onSelectEngine,
  options = [],
  onConfigChange,
  disabled,
  loading,
  error,
  connectionFailure,
  onRetry,
  connectionChoices = [],
  connectionProfileId,
  onSelectConnection,
  connectionLabel,
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
          className="inline-flex size-7 shrink-0 items-center justify-center grayscale opacity-60"
          data-testid="session-engine-indicator"
        >
          <TaskClientLogo engine={engine} />
        </span>
      )}
      {onSelectEngine && onSelectConnection && connectionChoices.length > 1 ? (
        // 连接配置只在草稿可改；选择由草稿 owner 记录上次使用并重建预热，不在此保存第二份状态。
        <EngineConfigMenu
          option={{
            id: "connection",
            name: intl.formatMessage({ id: "engine.profile.composer" }),
            currentValue: connectionProfileId ?? "",
            options: connectionChoices.map((choice) => ({
              value: choice.id,
              name: choice.name,
              ...(choice.description ? { description: choice.description } : {}),
            })),
          }}
          icon={PlugIcon}
          // 与引擎选择一致：连接中或连接失败时仍可改选连接，由草稿 owner 回收旧预热。
          disabled={disabled}
          open={activePicker === "connection"}
          restoreFocus={activePicker === null || activePicker === "connection"}
          onOpenChange={(open) =>
            setActivePicker((current) =>
              open ? "connection" : current === "connection" ? null : current,
            )
          }
          onValueChange={(value) => {
            if (value !== connectionProfileId) onSelectConnection(value);
          }}
        />
      ) : null}
      {!onSelectEngine && connectionLabel ? (
        <span
          className="max-w-32 truncate px-1 text-ui-sm text-foreground-subtle data-[composer-compact=true]:hidden"
          title={intl.formatMessage({ id: "engine.profile.boundTitle" }, { name: connectionLabel })}
          data-composer-collapse-priority="3"
          data-testid="session-engine-connection"
        >
          {connectionLabel}
        </span>
      ) : null}
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
            <ErrorDiagnostics
              text={diagnostic}
              label={intl.formatMessage({ id: "engine.errorDetails" })}
              copyLabel={intl.formatMessage({ id: "engine.copyErrorDetails" })}
            />
          ) : null}
        </div>
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
