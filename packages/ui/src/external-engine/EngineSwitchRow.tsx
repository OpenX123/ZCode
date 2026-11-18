import { useRef, type KeyboardEvent } from "react";
import type { SessionEngine } from "@zcode/shared/external-engine";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ENGINE_LABELS, type EngineSwitchRowProps } from "./contract.js";
import { TaskClientLogo } from "./TaskClientLogo.js";

const ENGINES = Object.keys(ENGINE_LABELS) as SessionEngine[];

/**
 * 挂载切换行的弹层/菜单宽度：`max(18rem, 切换行内容宽度)`，保证三段等宽且「Claude Code」完整显示。
 * 除切换行宿主（`data-engine-switch-host`）外的直接子节点用 `contain: inline-size` 退出撑宽，
 * 长模型名等仍按弹层宽度截断，不会把弹层撑宽；上限由各浮层自身的视口 max-width 约束。
 */
export const ENGINE_SWITCH_HOST_CLASS =
  "w-max min-w-72 [&>*:not([data-engine-switch-host])]:[contain:inline-size]";

/**
 * 模型入口弹层顶部的引擎切换行（W2）。只展示，选择经调用方的 `handleSelectEngine` 写入既有 draft owner。
 * 左右方向键与 Home/End 按 radio group 语义移动并选中；上下键留给外层菜单/弹层导航。
 */
export function EngineSwitchRow({ engine, onSelectEngine, disabled }: EngineSwitchRowProps) {
  const { intl } = useZCodeIntl();
  const radioRefs = useRef<Partial<Record<SessionEngine, HTMLButtonElement | null>>>({});
  const groupLabel = intl.formatMessage({ id: "engine.select" });
  if (!onSelectEngine) {
    const lockedHint = intl.formatMessage({ id: "engine.switch.locked" });
    return (
      <div
        data-testid="engine-switch-row"
        data-engine-switch-host=""
        data-readonly="true"
        aria-label={groupLabel}
        title={lockedHint}
        className="flex h-8 min-w-0 items-center gap-1.5 px-1 text-ui-sm text-foreground-subtle"
      >
        <TaskClientLogo engine={engine} />
        <span className="min-w-0 truncate text-foreground">{ENGINE_LABELS[engine]}</span>
      </div>
    );
  }
  const select = (next: SessionEngine) => {
    if (disabled || next === engine) return;
    onSelectEngine(next);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: SessionEngine) => {
    const index = ENGINES.indexOf(current);
    const target =
      event.key === "ArrowRight"
        ? ENGINES[(index + 1) % ENGINES.length]
        : event.key === "ArrowLeft"
          ? ENGINES[(index - 1 + ENGINES.length) % ENGINES.length]
          : event.key === "Home"
            ? ENGINES[0]
            : event.key === "End"
              ? ENGINES.at(-1)
              : undefined;
    if (!target) return;
    // 菜单内的 roving/typeahead 会吞掉方向键；只拦截本行处理的键。
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    radioRefs.current[target]?.focus();
    select(target);
  };
  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      aria-disabled={disabled || undefined}
      data-testid="engine-switch-row"
      data-engine-switch-host=""
      // 修复原因：flex-1 + truncate 在 18rem 弹层里把「Claude Code」截成「Claude…」，三段视觉宽度也随
      // 内容不一致。改为三等分网格列：列宽取最宽一项的内容宽度，弹层按此撑宽（见 ENGINE_SWITCH_HOST_CLASS）。
      className="grid min-w-0 grid-cols-3 gap-0.5 rounded-lg bg-foreground/5 p-0.5"
    >
      {ENGINES.map((value) => {
        const checked = value === engine;
        const label = ENGINE_LABELS[value];
        return (
          <button
            key={value}
            ref={(node) => {
              radioRefs.current[value] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            data-testid={`engine-switch-option-${value}`}
            className={cn(
              "flex h-7 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-ui-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-foreground-subtle disabled:cursor-default disabled:opacity-60",
              checked
                ? "bg-menu text-foreground shadow-sm"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            onClick={() => select(value)}
            onKeyDown={(event) => handleKeyDown(event, value)}
          >
            <TaskClientLogo engine={value} size="compact" />
            <span className="min-w-0 overflow-hidden">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
