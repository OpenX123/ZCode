import {
  EXTERNAL_ENGINE_RUNTIMES,
  engineConfigOptionPlacement,
  engineFastToggle,
  type EngineConfigOption,
} from "@zcode/shared/external-engine";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ENGINE_LABELS, type EngineControlsProps } from "./contract.js";
import { TaskClientLogo } from "./TaskClientLogo.js";
import { ErrorDiagnostics } from "@/components/ai-elements/error-diagnostics.js";
import { EngineConfigMenu, EngineModelPopover } from "./EngineConfigPicker.js";
import {
  ENGINE_DEFAULT_ALIAS,
  engineEffortCurrentLabel,
  engineModelCurrentLabel,
} from "./engineOptionDisplay.js";

const MODEL_POPOVER_PICKER = "model-popover";

export function EngineControls({
  engine,
  engineSwitchRow,
  options = [],
  onConfigChange,
  disabled,
  loading,
  configPending,
  error,
  connectionFailure,
  onRetry,
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
  const configDisabled = Boolean(
    disabled || loading || configPending || failureMessage || !onConfigChange,
  );
  const commitConfig = (configId: string, value: string) => onConfigChange?.(configId, value);

  // W1/R2-1 放置规则：左侧只有权限（mode）；模型/深度/Fast 进弹层；其余进「更多选项」。
  const model = options.find((option) => engineConfigOptionPlacement(option.id) === "model");
  const effort = options.find((option) => engineConfigOptionPlacement(option.id) === "effort");
  const fastOption = options.find(
    (option) => engineConfigOptionPlacement(option.id) === "fast" && engineFastToggle(option),
  );
  const fastToggle = fastOption ? engineFastToggle(fastOption) : null;
  const fast = fastOption && fastToggle ? { option: fastOption, toggle: fastToggle } : undefined;
  const modeOptions = options.filter(
    (option) => engineConfigOptionPlacement(option.id) === "primary-mode",
  );
  const more = options.filter(
    (option) =>
      option !== model &&
      option !== effort &&
      option !== fastOption &&
      engineConfigOptionPlacement(option.id) !== "primary-mode",
  );

  const renderMenu = (option: EngineConfigOption) => {
    const picker = `config:${option.id}`;
    return (
      <EngineConfigMenu
        key={option.id}
        option={option}
        disabled={configDisabled}
        open={activePicker === picker}
        restoreFocus={activePicker === null || activePicker === picker}
        onOpenChange={(open) =>
          setActivePicker((current) => (open ? picker : current === picker ? null : current))
        }
        onValueChange={(value) => commitConfig(option.id, value)}
      />
    );
  };
  const moreControls = more.length ? (
    <details data-testid="engine-more-options" className="w-full border-t border-border px-1 pt-2">
      <summary className="cursor-pointer text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.moreOptions" })}
      </summary>
      <div className="pt-1">
        {more.map((option) => (
          <div key={option.id} className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-ui-sm">{option.name}</span>
            {renderMenu(option)}
          </div>
        ))}
      </div>
    </details>
  ) : null;

  const modelLabel = model ? engineModelCurrentLabel(intl, model) : undefined;
  const effortLabel = effort ? engineEffortCurrentLabel(intl, effort) : undefined;
  // W1：模型为 adapter 的 `default` 别名时入口只显示档位，否则「模型 · 档位」。
  const triggerLabel =
    model && modelLabel
      ? effortLabel
        ? model.currentValue === ENGINE_DEFAULT_ALIAS
          ? { text: effortLabel }
          : { modelPart: modelLabel, effortPart: effortLabel }
        : { text: modelLabel }
      : effort
        ? { text: effortLabel ?? effort.name }
        : fast || more.length
          ? { text: intl.formatMessage({ id: "engine.moreOptions" }) }
          : { text: ENGINE_LABELS[engine] };
  const triggerText = triggerLabel.modelPart
    ? `${triggerLabel.modelPart} · ${triggerLabel.effortPart}`
    : (triggerLabel.text ?? "");
  const hasInteractiveConfig =
    (effort?.options.length ?? 0) > 0 ||
    (model?.options.length ?? 0) > 0 ||
    Boolean(fast) ||
    more.length > 0;
  const combinedOpen =
    activePicker === MODEL_POPOVER_PICKER ||
    activePicker === "config:model" ||
    more.some((option) => activePicker === `config:${option.id}`);
  const modelControls =
    model || effort || fast || more.length || engineSwitchRow ? (
      <EngineModelPopover
        model={model}
        effort={effort}
        fast={fast}
        moreControls={moreControls}
        engineSwitchRow={engineSwitchRow}
        triggerIcon={<TaskClientLogo engine={engine} size="compact" />}
        triggerLabel={triggerLabel}
        // 仅深度时沿用深度名作为可访问名称；有模型时读出可见的「模型 · 档位」。
        triggerAriaLabel={model ? triggerText : (effort?.name ?? triggerText)}
        // 切换行存在时入口不随原生配置禁用：草稿连接中或失败仍要能换引擎。
        triggerDisabled={engineSwitchRow ? false : configDisabled || !hasInteractiveConfig}
        configDisabled={configDisabled}
        open={combinedOpen}
        // 旧弹层退出动画完成时不能抢回新权限菜单的焦点；只在本簇关闭时回焦。
        restoreFocus={activePicker === null || combinedOpen}
        onOpenChange={(open) => setActivePicker(open ? MODEL_POPOVER_PICKER : null)}
        modelMenu={{
          open: activePicker === "config:model",
          // 模型菜单关闭会连带关闭弹层，由弹层把焦点还给入口按钮。
          restoreFocus: false,
          onOpenChange: (open) =>
            setActivePicker((current) =>
              open ? "config:model" : current === "config:model" ? null : current,
            ),
        }}
        onConfigChange={(configId, value) => commitConfig(configId, value)}
      />
    ) : null;
  const leadingActions = (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="external-engine-controls"
    >
      {modeOptions.map(renderMenu)}
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
    <div className="flex min-w-0 items-center gap-1" data-testid="external-engine-toolbar">
      {leadingActions}
      {modelControls}
    </div>
  );
}
