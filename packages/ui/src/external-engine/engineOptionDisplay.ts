import type { EngineConfigOption, EngineConfigOptionValue } from "@zcode/shared/external-engine";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/** adapter 的模型别名：Claude 未声明 AIR recommendedValue 时保留 `value:"default"` 条目。 */
export const ENGINE_DEFAULT_ALIAS = "default";

const KNOWN_EFFORT_VALUES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_PLAIN_MODEL_NAME_LENGTH = 48;

/**
 * 从 `default` 模型条目的 description 解析真实模型名。Claude adapter（session-model.js
 * `buildModelConfigOption`）在解析出 resolvedModel 时把 description 设为真实模型 displayName
 * （或 resolvedModel id）；否则为 SDK 原文，可能形如 `... (currently Sonnet 4.6) ...`。
 * 句子式描述无法可靠取名时返回 undefined，由调用方显示本地化「默认模型」。
 */
export function parseEngineDefaultModelName(description: string | undefined): string | undefined {
  const text = description?.trim();
  if (!text) return undefined;
  const current = /\(currently\s+([^)]+)\)/i.exec(text)?.[1]?.trim();
  if (current) return current;
  if (
    text.length <= MAX_PLAIN_MODEL_NAME_LENGTH &&
    !text.includes("(") &&
    !text.includes("·") &&
    !/[.。]$/.test(text)
  )
    return text;
  return undefined;
}

export function isEngineDefaultModelEntry(entry: EngineConfigOptionValue | undefined): boolean {
  return entry?.value === ENGINE_DEFAULT_ALIAS;
}

/** 模型条目显示名：`default` 别名不显示 adapter name（如 "Default (recommended)"）。 */
export function engineModelEntryLabel(intl: IntlInstance, entry: EngineConfigOptionValue): string {
  if (!isEngineDefaultModelEntry(entry)) return entry.name;
  return (
    parseEngineDefaultModelName(entry.description) ??
    intl.formatMessage({ id: "engine.model.default" })
  );
}

/** 当前模型显示名；当前值不在目录中时沿用原始值，空值返回 undefined。 */
export function engineModelCurrentLabel(
  intl: IntlInstance,
  option: EngineConfigOption,
): string | undefined {
  const entry = option.options.find((candidate) => candidate.value === option.currentValue);
  if (entry) return engineModelEntryLabel(intl, entry);
  if (option.currentValue === ENGINE_DEFAULT_ALIAS)
    return intl.formatMessage({ id: "engine.model.default" });
  return option.currentValue || undefined;
}

/** 思考档位显示名：已知取值本地化，未知取值沿用 adapter 文案；提交仍用原始 value。 */
export function engineEffortEntryLabel(intl: IntlInstance, entry: EngineConfigOptionValue): string {
  const value = entry.value.toLowerCase();
  if (value === ENGINE_DEFAULT_ALIAS) return intl.formatMessage({ id: "engine.effort.default" });
  return KNOWN_EFFORT_VALUES.has(value)
    ? intl.formatMessage({ id: `engine.effort.${value}` })
    : entry.name;
}

/** 滑杆档位：存在其他档位时隐藏 `default`，顺序保持引擎目录。 */
export function engineVisibleEffortEntries(option: EngineConfigOption): EngineConfigOptionValue[] {
  const concrete = option.options.filter((entry) => entry.value !== ENGINE_DEFAULT_ALIAS);
  return concrete.length > 0 ? concrete : option.options;
}

/** 当前档位显示名；当前值不在目录中时沿用原始值。 */
export function engineEffortCurrentLabel(
  intl: IntlInstance,
  option: EngineConfigOption,
): string | undefined {
  const entry = option.options.find((candidate) => candidate.value === option.currentValue);
  if (entry) return engineEffortEntryLabel(intl, entry);
  return option.currentValue || undefined;
}
