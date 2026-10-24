// 动态工作流模式由本地环境、用户设置和内置默认值决定。

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/** 本地环境覆盖；用户在设置中的明确选择优先于此默认值。 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** 本地未明确配置时按需启用工作流。 */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "onDemand";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * 「功能是否提供」的折叠：`onDemand` 与 `alwaysOn` 同为开启——目录里的 `/workflow`、技能、
 * 自动化页的工作流 tab 与 Resume 入口在两种模式下都在。两者的差别只在模型工具面的注册时机
 * （launch.md「On demand: activation」），由 CLI 侧按 mode 本身裁决，这里不参与。
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** 默认模式来自本地环境覆盖或内置默认值；用户选择单独记录。 */
export type DynamicWorkflowClientConfigSource = "override" | "default";

/**
 * 本地模式快照。两层：
 *   - 提供（offer）：本地环境或内置默认决定默认是哪个模式，记在 `offeredMode`（disabled 也只是默认值）；
 *   - 生效（effective）：用户在设置里的明确选择永远取代提供的模式，记在 `mode` / `enabled`。
 * 旧消费者读 `mode` / `enabled` 即得生效值；设置页读 `offeredMode` 决定「默认」标签。
 */
export interface DynamicWorkflowClientConfig {
  /** 生效模式：用户有选择时是用户选择，否则等于 offeredMode。 */
  readonly mode: DynamicWorkflowMode;
  /** 等于 isDynamicWorkflowModeEnabled(mode)；单独落字段免得每个消费者各写一遍折叠规则。 */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
  /** 本地提供的模式：用户没选时的生效模式，也是设置页的「默认」选项。 */
  readonly offeredMode: DynamicWorkflowMode;
  /** 实际生效的用户选择；缺席表示跟随提供的模式（未选择或非法值）。 */
  readonly userMode?: DynamicWorkflowMode;
}

export function createDynamicWorkflowClientConfig(
  offeredMode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return {
    mode: offeredMode,
    enabled: isDynamicWorkflowModeEnabled(offeredMode),
    source,
    offeredMode,
  };
}

/**
 * 读快照里的本地默认模式（与用户选择无关）；设置行与中枢的「工作流设置」只在读得到时出现。
 * disabled 也是合法的默认值：此时行照样出现，「默认」标签落在「关闭」上。
 *
 * 快照可能来自没有 offeredMode 的旧 Host。旧 Host 不认
 * 用户选择，摆出设置行只会把选择写进一个不生效的设置，所以缺席或读不懂的 offeredMode 返回 undefined：
 * 只有认用户选择的 Host 才会写这个字段。
 */
export function readDynamicWorkflowOfferedMode(
  config: DynamicWorkflowClientConfig,
): DynamicWorkflowMode | undefined {
  return normalizeDynamicWorkflowMode(config.offeredMode);
}

/**
 * 用户的明确选择永远取代本地默认模式：
 *   - 合法的用户选择取代提供的模式，提供的是 disabled 也一样——环境变量只决定默认值；
 *   - 缺席或非法值（旧文件、未来版本写入的新值）按跟随提供的模式处理。
 * 只从 `offeredMode` 推导，所以对已应用过选择的快照再次应用是覆盖而不是叠加：Host 闩住的是提供，
 * 每次使用都用最新选择重新应用。
 */
export function applyDynamicWorkflowUserMode(
  config: DynamicWorkflowClientConfig,
  userMode: unknown,
): DynamicWorkflowClientConfig {
  const offer = createDynamicWorkflowClientConfig(config.offeredMode, config.source);
  const choice = normalizeDynamicWorkflowMode(userMode);
  if (!choice) return offer;
  return {
    ...offer,
    mode: choice,
    enabled: isDynamicWorkflowModeEnabled(choice),
    userMode: choice,
  };
}

/** 本地环境决定默认模式，用户设置决定生效模式；remote 仅兼容旧调用，不会读取。 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote?: unknown;
  env?: Record<string, string | undefined>;
  userMode?: unknown;
}): DynamicWorkflowClientConfig {
  return applyDynamicWorkflowUserMode(resolveDynamicWorkflowOffer(input), input.userMode);
}

function resolveDynamicWorkflowOffer(input: {
  remote?: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
