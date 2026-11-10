import type { EngineConfigOption, ExternalSessionEngine } from "./contract.js";

/**
 * 原生配置项的展示与记忆类别：`model` 与思考深度（`effort`、`reasoning_effort`、
 * `reasoning-effort`、`thought_level`，去掉连接符并忽略大小写）；权限模式等其余配置为 other。
 */
export type EngineConfigOptionKind = "model" | "effort" | "other";

const ENGINE_EFFORT_CONFIG_IDS = new Set(["effort", "reasoningeffort", "thoughtlevel"]);

/** configId 归一化：去掉 `-`/`_` 并忽略大小写（Claude `fast` 与 Codex `fast-mode` 等同类）。 */
function normalizeConfigId(configId: string): string {
  return configId.replace(/[-_]/g, "").toLowerCase();
}

export function engineConfigOptionKind(configId: string): EngineConfigOptionKind {
  if (configId === "model") return "model";
  return ENGINE_EFFORT_CONFIG_IDS.has(normalizeConfigId(configId)) ? "effort" : "other";
}

/**
 * 输入区放置（docs/desktop/external-agent-engines-spec.md「Composer 引擎切换与外部引擎输入区」）：
 * - `primary-mode`：权限模式（id 原样为 `mode`），唯一的输入框左侧常驻芯片；
 * - `model` / `effort`：模型入口弹层头部行与滑杆；
 * - `fast`：Fast 类（归一化 id ∈ fast/fastmode/speed/servicetier），弹层左上角闪电开关；
 * - `more`：其余（Claude `agent`、Codex `collaboration_mode` 等），弹层「更多选项」。
 */
export type EngineConfigOptionPlacement = "primary-mode" | "model" | "effort" | "fast" | "more";

const ENGINE_FAST_CONFIG_IDS = new Set(["fast", "fastmode", "speed", "servicetier"]);

export function engineConfigOptionPlacement(configId: string): EngineConfigOptionPlacement {
  if (configId === "mode") return "primary-mode";
  const kind = engineConfigOptionKind(configId);
  if (kind !== "other") return kind;
  return ENGINE_FAST_CONFIG_IDS.has(normalizeConfigId(configId)) ? "fast" : "more";
}

/** Fast 开关的原始取值映射；`enabled` 只来自 snapshot 确认的 currentValue。 */
export interface EngineFastToggle {
  enabled: boolean;
  onValue: string;
  offValue: string;
}

const FAST_ON_VALUES = new Set(["on", "true", "enabled"]);
const FAST_OFF_VALUES = new Set(["off", "false", "disabled"]);

/**
 * Fast 类选项能否表示为开关。YCode 不声明 `session.configOptions.boolean`，本机 Claude adapter
 * 0.95.0（id `fast`）与 Codex adapter 2.2.2（id `fast-mode`）都退化为 `on`/`off` 两值 select。
 * 只有恰好一个开启值与一个关闭值时才映射；多档 service tier 或未知取值返回 null，交给「更多选项」。
 */
export function engineFastToggle(option: EngineConfigOption): EngineFastToggle | null {
  if (engineConfigOptionPlacement(option.id) !== "fast" || option.options.length !== 2) return null;
  const on = option.options.find((entry) => FAST_ON_VALUES.has(entry.value.toLowerCase()));
  const off = option.options.find((entry) => FAST_OFF_VALUES.has(entry.value.toLowerCase()));
  if (!on || !off) return null;
  return { enabled: option.currentValue === on.value, onValue: on.value, offValue: off.value };
}

/** ACP 权限模式的 configId；只有恰为该 ID 的配置按模式记忆（2026-11-09 起）。 */
export const ENGINE_MODE_CONFIG_ID = "mode";
/** 计划类权限模式取值（Claude `plan`，忽略大小写）：新草稿不沿用，与 YCode「Plan 不沿用」一致。 */
const ENGINE_PLAN_MODE_VALUES = new Set(["plan"]);

/**
 * 是否可写入/恢复按引擎 + 连接的本机记忆：模型、思考深度，以及非计划类的权限模式。
 * 其余配置（fast、协作模式等）不记忆。
 */
export function isRememberableEngineConfig(configId: string, value: string): boolean {
  if (engineConfigOptionKind(configId) !== "other") return true;
  return configId === ENGINE_MODE_CONFIG_ID && !ENGINE_PLAN_MODE_VALUES.has(value.toLowerCase());
}

/** 本机按外部引擎记忆的已确认原生值（ACP configId → 原始 value），含模型、思考深度与非计划权限模式。 */
export type ExternalEngineConfigPreferences = Partial<
  Record<ExternalSessionEngine, Record<string, string>>
>;

/** 本机按引擎与连接配置隔离的确认偏好；不存在连接记录时才兼容读取旧引擎偏好。 */
export type ExternalEngineConnectionConfigPreferences = Partial<
  Record<ExternalSessionEngine, Record<string, Record<string, string>>>
>;
