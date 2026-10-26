import { useLayoutEffect, useState } from "react";
import { BrainIcon, ChevronDownIcon, CpuIcon, Settings2Icon, ShieldIcon } from "lucide-react";
import type { EngineConfigOption } from "@zcode/shared/external-engine";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
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
  onValueChange: (value: string) => void;
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
}: PickerProps) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [rows, setRows] = useState(option.options.length || 1);

  useLayoutEffect(() => {
    if (!open) return;
    if (!content) return;
    const update = () => {
      // 按 Popper 实际可用高度分列，不裁切列表，也不靠隐藏滚动条掩盖遗漏的选项。
      const available =
        Number.parseFloat(
          getComputedStyle(content).getPropertyValue(
            "--radix-dropdown-menu-content-available-height",
          ),
        ) || window.innerHeight - 24;
      setRows(Math.max(1, Math.floor((available - 40) / 34)));
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(content);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [content, open, option.options.length]);

  const columns = Math.max(1, Math.ceil(option.options.length / rows));
  const rowCount = Math.max(1, Math.ceil(option.options.length / columns));
  const Icon = option.id === "model" ? CpuIcon : option.id === "mode" ? ShieldIcon : Settings2Icon;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || option.options.length === 0}
          className={engineTriggerClassName}
          aria-label={option.name}
          title={currentLabel(option)}
          data-composer-collapse-priority="3"
          data-testid={`engine-config-${option.id}`}
        >
          <Icon className="hidden size-4 group-data-[composer-compact=true]/engine-option:block" />
          <span className="truncate group-data-[composer-compact=true]/engine-option:hidden">
            {currentLabel(option)}
          </span>
          <ChevronDownIcon className="size-3.5 text-foreground-subtle group-data-[composer-compact=true]/engine-option:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={setContent}
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="max-h-none max-w-[calc(100vw-1.5rem)] overflow-visible"
        style={{ width: columns * 240 }}
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
          className="grid grid-flow-col gap-0.5"
          style={{
            gridTemplateRows: `repeat(${rowCount}, 2rem)`,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
        >
          {option.options.map((entry) => (
            <DropdownMenuRadioItem
              key={entry.value}
              value={entry.value}
              disabled={disabled}
              title={entry.description ?? entry.name}
              className="h-8 min-h-8 cursor-pointer py-1"
            >
              <span className="truncate">{entry.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EngineEffortPicker({
  option,
  modelLabel,
  disabled,
  open,
  restoreFocus,
  onOpenChange,
  onValueChange,
}: PickerProps & { modelLabel?: string }) {
  // 仅保存尚未提交的手势预览；snapshot 更新后，旧预览不能覆盖新目录或权威值。
  const scope = JSON.stringify([option.currentValue, option.options]);
  const [preview, setPreview] = useState<{ scope: string; index: number } | null>(null);
  const currentIndex = option.options.findIndex((entry) => entry.value === option.currentValue);
  const index = preview?.scope === scope ? preview.index : currentIndex;
  const label = option.options[index]?.name ?? currentLabel(option);
  const progress = option.options.length > 1 ? Math.max(0, index) / (option.options.length - 1) : 0;
  const sliderDisabled = disabled || option.options.length < 2;
  const commit = (nextIndex: number) => {
    const entry = option.options[nextIndex];
    setPreview(null);
    if (!sliderDisabled && entry && entry.value !== option.currentValue) onValueChange(entry.value);
  };
  const changeOpen = (next: boolean) => {
    setPreview(null);
    onOpenChange(next);
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={engineTriggerClassName}
          disabled={disabled || option.options.length === 0}
          aria-label={option.name}
          title={currentLabel(option)}
          data-composer-collapse-priority="3"
          data-testid={`engine-config-${option.id}`}
        >
          <BrainIcon className="hidden size-4 group-data-[composer-compact=true]/engine-option:block" />
          <span className="truncate group-data-[composer-compact=true]/engine-option:hidden">
            {currentLabel(option)}
          </span>
          <ChevronDownIcon className="size-3.5 text-foreground-subtle group-data-[composer-compact=true]/engine-option:hidden" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        aria-label={option.name}
        className="w-64 max-w-[calc(100vw-1.5rem)] gap-2 bg-menu p-3 text-foreground"
        data-testid={`engine-effort-menu-${option.id}`}
        onEscapeKeyDown={() => setPreview(null)}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus) event.preventDefault();
        }}
      >
        <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
          <span
            className="text-ui-base font-medium text-icon-blue"
            data-testid="engine-effort-value"
          >
            {label}
          </span>
          <span className="max-w-full truncate text-ui-sm text-foreground-subtle">
            {modelLabel ?? option.name}
          </span>
        </div>
        <div
          className="composer-thought-slider relative h-8 w-full rounded-full"
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
              {option.options.map((entry, stop) => (
                <span
                  key={entry.value}
                  data-filled={stop <= index}
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
            max={Math.max(0, option.options.length - 1)}
            step={1}
            value={Math.max(0, index)}
            disabled={sliderDisabled}
            aria-label={option.name}
            aria-valuetext={label}
            data-testid={`engine-effort-slider-${option.id}`}
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
      </PopoverContent>
    </Popover>
  );
}
