import type { ExternalSessionEngine } from "./contract.js";

/**
 * 原生配置项的展示与记忆类别：`model` 与思考深度（`effort`、`reasoning_effort`、
 * `reasoning-effort`、`thought_level`，去掉连接符并忽略大小写）；权限模式等其余配置为 other。
 */
export type EngineConfigOptionKind = "model" | "effort" | "other";

const ENGINE_EFFORT_CONFIG_IDS = new Set(["effort", "reasoningeffort", "thoughtlevel"]);

export function engineConfigOptionKind(configId: string): EngineConfigOptionKind {
  if (configId === "model") return "model";
  return ENGINE_EFFORT_CONFIG_IDS.has(configId.replace(/[-_]/g, "").toLowerCase())
    ? "effort"
    : "other";
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
