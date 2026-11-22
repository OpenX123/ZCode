import type { EngineConfigOption, EngineConfigOptionValue } from "@zcode/shared/external-engine";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { thoughtLevelShortLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";

/** adapter 的模型别名：Claude 未声明 AIR recommendedValue 时保留 `value:"default"` 条目。 */
export const ENGINE_DEFAULT_ALIAS = "default";

const KNOWN_EFFORT_VALUES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_PLAIN_MODEL_NAME_LENGTH = 48;

const CONTEXT_SUFFIX_PATTERN = /\s*(?:\(\s*\d+\s*[mk]\s+context\s*\)|\[\d+[mk]\])\s*$/i;
// 新格式 `claude-opus-5-5`（可带日期 / `-vN:M` / `[1m]`），provider 前缀在调用前剥掉。
const CLAUDE_MODEL_ID_PATTERN =
  /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:\[\d+[mk]\])?$/i;
// 旧格式 `claude-3-5-sonnet-20241022`。
const LEGACY_CLAUDE_MODEL_ID_PATTERN =
  /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:\[\d+[mk]\])?$/i;

/** `(currently X)` 中的 X；X 内允许再嵌一层括号（`Opus 5.5 (1M context)`）。 */
function extractCurrentlyClause(text: string): string | undefined {
  const match = /\(currently\s+/i.exec(text);
  if (!match) return undefined;
  let depth = 1;
  const start = match.index + match[0].length;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  return undefined;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Claude 模型 id → 「家族 主.次」：`us.anthropic.claude-opus-5-5-v1:0` → `Opus 5.5`。 */
function formatClaudeModelId(candidate: string): string | undefined {
  const id = candidate
    .trim()
    .replace(/^.*anthropic\./i, "")
    .replace(/^anthropic\//i, "");
  const modern = CLAUDE_MODEL_ID_PATTERN.exec(id);
  if (modern) {
    const [, family = "", major = "", minor] = modern;
    return `${capitalize(family)} ${minor ? `${major}.${minor}` : major}`;
  }
  const legacy = LEGACY_CLAUDE_MODEL_ID_PATTERN.exec(id);
  if (legacy) {
    const [, major = "", minor, family = ""] = legacy;
    return `${capitalize(family)} ${minor ? `${major}.${minor}` : major}`;
  }
  return undefined;
}

/**
 * 从 `default` 模型条目的 description 解析真实模型名。Claude adapter（session-model.js
 * `buildModelConfigOption`）在解析出 resolvedModel 时把 description 设为对应条目的 displayName，
 * 匹配不到对应条目时为 resolvedModel id；否则为 SDK 原文。
 *
 * Bug 修复（1.5.1）：旧实现只认 `(currently X)` 与「短且不含括号/`·`」的整串，本机实测的常见形态
 * 全部解析失败或解析错——SDK 的 `default` 与别名条目 resolvedModel 大小写不同
 * （`claude-opus-5-5[1m]` / `[1M]`），adapter 严格相等匹配失败，description 退化为原始 id，界面直接显示
 * `claude-opus-5-5[1m]`；SDK 原文 `(currently Opus 5.5 (1M context))` 括号嵌套，旧正则截成
 * `Opus 5.5 (1M context`；served 形态 `Opus 5.5 · Best for …` 因含 `·` 被整体放弃。
 * 规则与实测形态表见 docs/desktop/external-agent-engines-spec.md「`default` 模型别名显示」。
 * 句子式描述无法可靠取名时返回 undefined，由调用方显示本地化「默认模型」/ `Auto`。
 */
export function parseEngineDefaultModelName(description: string | undefined): string | undefined {
  const text = description?.trim();
  if (!text) return undefined;
  const clause = extractCurrentlyClause(text);
  const raw = clause !== undefined ? clause : (text.split(/\s+·\s+/)[0] ?? "");
  const candidate = raw.replace(CONTEXT_SUFFIX_PATTERN, "").trim();
  if (!candidate) return undefined;
  const fromId = formatClaudeModelId(candidate);
  if (fromId) return fromId;
  if (
    candidate.length <= MAX_PLAIN_MODEL_NAME_LENGTH &&
    !/[()[\]]/.test(candidate) &&
    !/[.。]$/.test(candidate)
  )
    return candidate;
  return undefined;
}

/**
 * 显示层去掉模型名开头的 `Claude `（1.5.0 B2）：`Claude Opus 4.7` → `Opus 4.7`。
 * 只在其后仍有内容时去掉；Codex 等其他名称（`GPT-5.5`）原样返回。catalog 原始值不改。
 */
export function stripClaudeModelPrefix(name: string): string {
  return name.replace(/^\s*claude\s+(?=\S)/i, "");
}

export function isEngineDefaultModelEntry(entry: EngineConfigOptionValue | undefined): boolean {
  return entry?.value === ENGINE_DEFAULT_ALIAS;
}

/** 模型条目显示名：`default` 别名不显示 adapter name（如 "Default (recommended)"）。 */
export function engineModelEntryLabel(intl: IntlInstance, entry: EngineConfigOptionValue): string {
  if (!isEngineDefaultModelEntry(entry)) return stripClaudeModelPrefix(entry.name);
  const parsed = parseEngineDefaultModelName(entry.description);
  return parsed
    ? stripClaudeModelPrefix(parsed)
    : intl.formatMessage({ id: "engine.model.default" });
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

/**
 * 入口按钮的模型段（1.5.1）：始终显示模型。`default` 解析出真实名时用真实名；解析不出时显示
 * 窄位置缩写 `Auto`，`accessibleText`（可访问名称与悬停）仍读本地化「默认模型」。
 */
export function engineModelTriggerLabel(
  intl: IntlInstance,
  option: EngineConfigOption,
): { text: string; accessibleText: string } | undefined {
  const entry = option.options.find((candidate) => candidate.value === option.currentValue);
  const isDefault = entry
    ? isEngineDefaultModelEntry(entry)
    : option.currentValue === ENGINE_DEFAULT_ALIAS;
  if (isDefault) {
    const parsed = parseEngineDefaultModelName(entry?.description);
    if (parsed) {
      const name = stripClaudeModelPrefix(parsed);
      return { text: name, accessibleText: name };
    }
    return {
      text: intl.formatMessage({ id: "engine.modelShort.default" }),
      accessibleText: intl.formatMessage({ id: "engine.model.default" }),
    };
  }
  const label = engineModelCurrentLabel(intl, option);
  return label ? { text: label, accessibleText: label } : undefined;
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

/**
 * 入口按钮上的档位缩写（≤5 个字母）：已知取值走共享缩写表，`default` 显示 `Auto`，
 * 未知取值回退全称 / adapter 文案。全称仍用于弹层头部、滑杆读数与无障碍名称。
 */
export function engineEffortEntryShortLabel(
  intl: IntlInstance,
  entry: EngineConfigOptionValue,
): string {
  if (entry.value.toLowerCase() === ENGINE_DEFAULT_ALIAS)
    return intl.formatMessage({ id: "engine.effortShort.default" });
  const shortId = thoughtLevelShortLabelId(entry.value);
  return shortId ? intl.formatMessage({ id: shortId }) : engineEffortEntryLabel(intl, entry);
}

/** 当前档位缩写；当前值不在目录中时沿用原始值。 */
export function engineEffortCurrentShortLabel(
  intl: IntlInstance,
  option: EngineConfigOption,
): string | undefined {
  const entry = option.options.find((candidate) => candidate.value === option.currentValue);
  if (entry) return engineEffortEntryShortLabel(intl, entry);
  return option.currentValue || undefined;
}

const EFFORT_HINT_VALUES = new Set(["default", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 档位说明：adapter 提供 description 时用原文，否则已知取值用内置说明；未知取值无说明。 */
export function engineEffortEntryHint(
  intl: IntlInstance,
  entry: EngineConfigOptionValue,
): string | undefined {
  const description = entry.description?.trim();
  if (description) return description;
  const value = entry.value.toLowerCase();
  return EFFORT_HINT_VALUES.has(value)
    ? intl.formatMessage({ id: `engine.effortShort.hint.${value}` })
    : undefined;
}
