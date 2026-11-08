import type {
  EngineConfigOption,
  EngineConnectionFailure,
  SessionEngine,
} from "@zcode/shared/external-engine";

export const ENGINE_LABELS: Record<SessionEngine, string> = {
  zcode: "ZCode",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export interface TaskClientLogoProps {
  engine?: SessionEngine;
}

export interface EngineConnectionChoice {
  id: string;
  name: string;
  /** 方式与网关说明，用于悬停提示。 */
  description?: string;
}

export interface EngineControlsProps {
  engine: SessionEngine;
  onSelectEngine?: (engine: SessionEngine) => void;
  options?: EngineConfigOption[];
  /** 返回 false 表示提交失败，控件撤销该次局部显示；确认配置仍只读 snapshot。 */
  onConfigChange?: (configId: string, value: string) => void | Promise<boolean>;
  disabled?: boolean;
  /** 已有会话连接中：显示连接中文案，原生配置不可写。 */
  loading?: boolean;
  /** 草稿原生配置就绪前：只禁用原生配置选择器，不显示连接中文案；引擎与连接配置仍可改选。 */
  configPending?: boolean;
  error?: string;
  connectionFailure?: EngineConnectionFailure;
  onRetry?: () => void;
  /** 工作区不能运行外部引擎时的原因；设置后外部引擎在选择器中灰显并就地说明。 */
  externalEngineUnavailableReason?: string;
  /** 草稿可选的连接配置（未隐藏）；只有多于一项时显示选择器。 */
  connectionChoices?: EngineConnectionChoice[];
  /** 当前草稿或会话绑定的配置 ID。 */
  connectionProfileId?: string;
  /** 仅草稿提供：选择后由草稿 owner 重建预热。 */
  onSelectConnection?: (profileId: string) => void;
  /** 已创建会话的只读绑定说明；缺省（内置缺省配置）不显示。 */
  connectionLabel?: string;
}

export interface EngineSettingsProps {
  /** 承载连接测试的本地 workspace；缺省时测试不可用。 */
  connectivityWorkspacePath?: string;
}

export function isEngineNotReadyError(error: unknown): boolean {
  const value = error as { code?: unknown; reasonCode?: unknown; message?: unknown } | null;
  return (
    value?.code === "ZCODE_AGENT_ENGINE_NOT_READY" ||
    value?.reasonCode === "engine_not_ready" ||
    /engine_not_ready|ZCODE_AGENT_ENGINE_NOT_READY/.test(String(value?.message ?? error))
  );
}
