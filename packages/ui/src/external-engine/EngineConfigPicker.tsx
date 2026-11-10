import { useState, type ReactNode } from "react";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  Settings2Icon,
  ShieldIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type {
  EngineConfigOption,
  EngineConfigOptionValue,
  EngineFastToggle,
} from "@zcode/shared/external-engine";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  engineEffortCurrentLabel,
  engineEffortEntryLabel,
  engineModelEntryLabel,
  engineVisibleEffortEntries,
  isEngineDefaultModelEntry,
} from "./engineOptionDisplay.js";
import "@/chat-input-toolbar/composer-thought-slider.css";

// 普通表单边框会割裂工具栏；键盘焦点用边框和底色，避免全局 shadow reset 吞掉 ring。
export const engineTriggerClassName =
  "group/engine-option h-7 w-auto max-w-48 gap-1 px-2 text-ui-sm focus-visible:border-foreground-subtle focus-visible:bg-hover data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0";

interface PickerProps {
  option: EngineConfigOption;
  disabled?: boolean;
  open: boolean;
  restoreFocus: boolean;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void | Promise<boolean>;
}

function currentLabel(option: EngineConfigOption) {
  return (
    (option.options.find((entry) => entry.value === option.currentValue)?.name ??
      option.currentValue) ||
    option.name
  );
}

export function EngineConfigMenu({
  option,
  disabled,
  open,
  restoreFocus,
  onOpenChange,
  onValueChange,
  icon,
  footer,
  triggerContent,
  triggerClassName,
  renderEntryLabel,
}: PickerProps & {
  icon?: LucideIcon;
  footer?: ReactNode;
  /** 替换默认的「当前值 ▾」触发内容（弹层头部行）；缺省为工具栏芯片样式。 */
  triggerContent?: ReactNode;
  triggerClassName?: string;
  /** 条目显示（如 `default` 模型别名显示解析名 + 默认标记）；回传值仍为原始 value。 */
  renderEntryLabel?: (entry: EngineConfigOptionValue) => ReactNode;
}) {
  const Icon =
    icon ?? (option.id === "model" ? CpuIcon : option.id === "mode" ? ShieldIcon : Settings2Icon);
  // 自测高分列曾覆盖共享限高并让长目录越出视口；直接沿用下拉层的尺寸和滚动约束。
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || option.options.length === 0}
          className={triggerClassName ?? engineTriggerClassName}
          aria-label={option.name}
          title={currentLabel(option)}
          data-composer-collapse-priority={triggerContent ? undefined : "3"}
          data-testid={`engine-config-${option.id}`}
        >
          {triggerContent ?? (
            <>
              <Icon className="hidden size-4 group-data-[composer-compact=true]/engine-option:block" />
              <span className="truncate group-data-[composer-compact=true]/engine-option:hidden">
                {currentLabel(option)}
              </span>
              <ChevronDownIcon className="size-3.5 text-foreground-subtle group-data-[composer-compact=true]/engine-option:hidden" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-60"
        data-testid={`engine-config-menu-${option.id}`}
        onCloseAutoFocus={(event) => {
          // 退出动画晚于新弹层打开时，旧菜单回焦会触发新弹层的 focusOutside 关闭。
          if (!restoreFocus) event.preventDefault();
        }}
      >
        <DropdownMenuLabel className="text-ui-sm font-normal text-foreground-subtle">
          {option.name}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={option.currentValue}
          onValueChange={onValueChange}
          aria-label={option.name}
        >
          {option.options.map((entry) => (
            <DropdownMenuRadioItem
              key={entry.value}
              value={entry.value}
              disabled={disabled}
              title={entry.description ?? entry.name}
              className="h-8 min-h-8 cursor-pointer py-1"
            >
              {renderEntryLabel ? (
                renderEntryLabel(entry)
              ) : (
                <span className="truncate">{entry.name}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {footer}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DefaultTag() {
  const { intl } = useZCodeIntl();
  return (
    <span className="shrink-0 rounded-sm bg-foreground/5 px-1 text-ui-xs text-foreground-subtle">
      {intl.formatMessage({ id: "engine.model.defaultTag" })}
    </span>
  );
}

/** 模型条目：`default` 别名显示解析出的真实模型名 + 「默认」，不显示 adapter name。 */
export function EngineModelEntryLabel({ entry }: { entry: EngineConfigOptionValue }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{engineModelEntryLabel(intl, entry)}</span>
      {isEngineDefaultModelEntry(entry) ? <DefaultTag /> : null}
    </span>
  );
}

interface NestedMenuState {
  open: boolean;
  restoreFocus: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface EngineModelPopoverProps {
  model?: EngineConfigOption;
  effort?: EngineConfigOption;
  fast?: { option: EngineConfigOption; toggle: EngineFastToggle };
  /** 「更多选项」区（由 EngineControls 组装，共享同一 activePicker owner）。 */
  moreControls?: ReactNode;
  engineSwitchRow?: ReactNode;
  triggerIcon: ReactNode;
  /** 入口文案；`modelPart` 存在时与 `effortPart` 分开渲染，窄宽度先截断模型名。 */
  triggerLabel: { modelPart?: string; effortPart?: string; text?: string };
  triggerAriaLabel: string;
  triggerDisabled: boolean;
  /** 原生配置不可写（连接中、失败、草稿未就绪或无回调）。 */
  configDisabled: boolean;
  open: boolean;
  restoreFocus: boolean;
  onOpenChange: (open: boolean) => void;
  modelMenu: NestedMenuState;
  onConfigChange: (configId: string, value: string) => void | Promise<boolean>;
}

/**
 * 外部引擎「模型 · 思考」弹层（W1/W2/R2-1）：引擎切换行 → `[⚡] 模型 档位 ›` 头部行 → 思考滑杆 → 更多选项。
 * 配置事实只读 snapshot；滑杆的局部预览只在手势与等待确认期间存在。
 */
export function EngineModelPopover({
  model,
  effort,
  fast,
  moreControls,
  engineSwitchRow,
  triggerIcon,
  triggerLabel,
  triggerAriaLabel,
  triggerDisabled,
  configDisabled,
  open,
  restoreFocus,
  onOpenChange,
  modelMenu,
  onConfigChange,
}: EngineModelPopoverProps) {
  const { intl } = useZCodeIntl();
  // 有具体档位时隐藏 adapter 的 `default` 档；提交仍回传原始 value。
  const levels = effort ? engineVisibleEffortEntries(effort) : [];
  // 手势与等待确认期间共用局部预览；新目录或确认值回流后仍由 snapshot 接管。
  const scope = JSON.stringify([effort?.currentValue, effort?.options]);
  const [preview, setPreview] = useState<{ scope: string; index: number } | null>(null);
  // 确认值或目录改变后彻底丢弃旧预览，避免后续切回同一档位时旧手势重新生效。
  if (preview && preview.scope !== scope) setPreview(null);
  const currentIndex = levels.findIndex((entry) => entry.value === effort?.currentValue);
  const index = preview?.scope === scope ? preview.index : currentIndex;
  const previewEntry = levels[index];
  const effortLabel = effort
    ? previewEntry
      ? engineEffortEntryLabel(intl, previewEntry)
      : (engineEffortCurrentLabel(intl, effort) ?? effort.name)
    : undefined;
  const progress = levels.length > 1 ? Math.max(0, index) / (levels.length - 1) : 0;
  const sliderDisabled = configDisabled || levels.length < 2;
  const commit = (nextIndex: number) => {
    const entry = levels[nextIndex];
    if (!effort || sliderDisabled || !entry || entry.value === effort.currentValue) {
      setPreview(null);
      return;
    }
    // 释放时立刻清空会先退回旧确认值，再随异步 snapshot 跳到新值；仅失败时撤销本次显示。
    const submitted = { scope, index: nextIndex };
    setPreview(submitted);
    const revert = () => setPreview((current) => (current === submitted ? null : current));
    void Promise.resolve(onConfigChange(effort.id, entry.value)).then((accepted) => {
      if (accepted === false) revert();
    }, revert);
  };
  const changeOpen = (next: boolean) => {
    setPreview(null);
    onOpenChange(next);
  };
  const currentModelEntry = model?.options.find((entry) => entry.value === model.currentValue);
  const effortValue = effortLabel ? (
    <span className="shrink-0 text-foreground-subtle" data-testid="engine-effort-value">
      {effortLabel}
    </span>
  ) : null;
  const fastToggle = fast ? (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={fast.toggle.enabled}
      aria-label={fast.option.name}
      title={fast.option.name}
      disabled={configDisabled}
      data-testid="engine-fast-toggle"
      className={cn(
        "size-7 shrink-0 p-0 focus-visible:bg-hover",
        // ghost 变体的 hover 文字色会盖掉点亮色：点击后指针仍停在按钮上时闪电显示为前景黑，
        // 看不出已开启（E2E 截图 w1-fast-lightning-on-popover 证据）。点亮态的 hover/focus 同样保持强调色。
        fast.toggle.enabled
          ? "text-icon-blue hover:text-icon-blue focus-visible:text-icon-blue"
          : "text-foreground-subtle",
      )}
      onClick={() =>
        void onConfigChange(
          fast.option.id,
          fast.toggle.enabled ? fast.toggle.offValue : fast.toggle.onValue,
        )
      }
    >
      <ZapIcon className={cn("size-4", fast.toggle.enabled && "fill-current")} />
    </Button>
  ) : null;
  const header =
    fast || model || effort ? (
      <div className="flex min-w-0 items-center gap-1" data-testid="engine-model-header">
        {fastToggle}
        {model ? (
          <EngineConfigMenu
            option={model}
            disabled={configDisabled}
            open={modelMenu.open}
            restoreFocus={modelMenu.restoreFocus}
            onOpenChange={modelMenu.onOpenChange}
            onValueChange={(value) => onConfigChange(model.id, value)}
            renderEntryLabel={(entry) => <EngineModelEntryLabel entry={entry} />}
            triggerClassName="h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-ui-sm focus-visible:bg-hover"
            triggerContent={
              <>
                <span className="min-w-0 truncate font-medium">
                  {currentModelEntry
                    ? engineModelEntryLabel(intl, currentModelEntry)
                    : model.currentValue || model.name}
                </span>
                {isEngineDefaultModelEntry(currentModelEntry) ? <DefaultTag /> : null}
                {effortValue}
                <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-foreground-subtle" />
              </>
            }
          />
        ) : (
          <span className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-ui-sm">
            {effortValue ?? (
              <span className="truncate text-foreground-subtle">{fast?.option.name}</span>
            )}
          </span>
        )}
      </div>
    ) : null;
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={engineTriggerClassName}
          disabled={triggerDisabled}
          aria-label={triggerAriaLabel}
          title={triggerAriaLabel}
          data-composer-collapse-priority="3"
          data-testid="engine-config-model-effort"
        >
          <span className="inline-flex shrink-0 group-data-[composer-compact=true]/engine-option:hidden">
            {triggerIcon}
          </span>
          <BrainIcon className="hidden size-4 group-data-[composer-compact=true]/engine-option:block" />
          {triggerLabel.modelPart ? (
            <>
              <span className="min-w-0 truncate group-data-[composer-compact=true]/engine-option:hidden">
                {triggerLabel.modelPart}
              </span>
              {triggerLabel.effortPart ? (
                <span className="shrink-0 group-data-[composer-compact=true]/engine-option:hidden">
                  {` · ${triggerLabel.effortPart}`}
                </span>
              ) : null}
            </>
          ) : (
            <span className="truncate group-data-[composer-compact=true]/engine-option:hidden">
              {triggerLabel.text}
            </span>
          )}
          <ChevronDownIcon className="size-3.5 text-foreground-subtle group-data-[composer-compact=true]/engine-option:hidden" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-label={triggerAriaLabel}
        className="w-72 max-w-[calc(100vw-1.5rem)] gap-2 bg-menu p-2 text-foreground"
        data-testid="engine-model-popover"
        onOpenAutoFocus={(event) => {
          // 顶部切换行与头部行之后，深度弹层仍让原生滑条优先接收键盘操作。
          const slider = (
            event.currentTarget as HTMLElement | null
          )?.querySelector<HTMLInputElement>('input[type="range"]');
          if (slider) {
            event.preventDefault();
            slider.focus();
          }
        }}
        onEscapeKeyDown={() => setPreview(null)}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus) event.preventDefault();
        }}
      >
        {engineSwitchRow}
        {header}
        {effort ? (
          <div
            className="composer-thought-slider relative mx-1 h-8 rounded-full"
            data-disabled={sliderDisabled}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              <div className="absolute inset-x-0 top-1 h-6 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-icon-blue"
                  style={{ width: index >= 0 ? `calc(14px + (100% - 28px) * ${progress})` : 0 }}
                />
              </div>
              <div className="absolute inset-x-3.5 inset-y-0 flex items-center justify-between">
                {levels.map((entry, stop) => (
                  <span
                    key={entry.value}
                    data-filled={index >= 0 && stop <= index}
                    className="composer-thought-slider-stop size-1 rounded-full"
                  />
                ))}
              </div>
              <div
                className="composer-thought-slider-thumb absolute top-0.5 size-7 rounded-full shadow-sm"
                style={{ left: `calc((100% - 28px) * ${progress})` }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, levels.length - 1)}
              step={1}
              value={Math.max(0, index)}
              disabled={sliderDisabled}
              aria-label={effort.name}
              aria-valuetext={effortLabel}
              data-testid={`engine-effort-slider-${effort.id}`}
              className="composer-thought-range absolute inset-0 m-0 h-8 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-default"
              onChange={(event) => setPreview({ scope, index: Number(event.currentTarget.value) })}
              onPointerUp={(event) => commit(Number(event.currentTarget.value))}
              onPointerCancel={() => setPreview(null)}
              onKeyUp={(event) => {
                if (
                  [
                    "ArrowLeft",
                    "ArrowRight",
                    "ArrowUp",
                    "ArrowDown",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                  ].includes(event.key)
                )
                  commit(Number(event.currentTarget.value));
              }}
            />
          </div>
        ) : null}
        {moreControls}
      </PopoverContent>
    </Popover>
  );
}
