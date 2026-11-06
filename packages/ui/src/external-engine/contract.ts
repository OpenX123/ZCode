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

export interface EngineControlsProps {
  engine: SessionEngine;
  onSelectEngine?: (engine: SessionEngine) => void;
  options?: EngineConfigOption[];
  /** 返回 false 表示提交失败，控件撤销该次局部显示；确认配置仍只读 snapshot。 */
  onConfigChange?: (configId: string, value: string) => void | Promise<boolean>;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  connectionFailure?: EngineConnectionFailure;
  onRetry?: () => void;
  /** 工作区不能运行外部引擎时的原因；设置后外部引擎在选择器中灰显并就地说明。 */
  externalEngineUnavailableReason?: string;
}

export function isEngineNotReadyError(error: unknown): boolean {
  const value = error as { code?: unknown; reasonCode?: unknown; message?: unknown } | null;
  return (
    value?.code === "ZCODE_AGENT_ENGINE_NOT_READY" ||
    value?.reasonCode === "engine_not_ready" ||
    /engine_not_ready|ZCODE_AGENT_ENGINE_NOT_READY/.test(String(value?.message ?? error))
  );
}
