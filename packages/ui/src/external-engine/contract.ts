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
}

export function isEngineNotReadyError(error: unknown): boolean {
  const value = error as { code?: unknown; reasonCode?: unknown; message?: unknown } | null;
  return (
    value?.code === "ZCODE_AGENT_ENGINE_NOT_READY" ||
    value?.reasonCode === "engine_not_ready" ||
    /engine_not_ready|ZCODE_AGENT_ENGINE_NOT_READY/.test(String(value?.message ?? error))
  );
}
