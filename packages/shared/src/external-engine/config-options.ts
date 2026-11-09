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

/** 本机按外部引擎记忆的已确认原生值（ACP configId → 原始 value），只含模型与思考深度。 */
export type ExternalEngineConfigPreferences = Partial<
  Record<ExternalSessionEngine, Record<string, string>>
>;

/** 本机按引擎与连接配置隔离的确认偏好；不存在连接记录时才兼容读取旧引擎偏好。 */
export type ExternalEngineConnectionConfigPreferences = Partial<
  Record<ExternalSessionEngine, Record<string, Record<string, string>>>
>;
