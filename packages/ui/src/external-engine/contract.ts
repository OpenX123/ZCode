import type { ReactNode } from "react";
import type {
  EngineConfigOption,
  EngineConnectionFailure,
  SessionEngine,
} from "@zcode/shared/external-engine";

/** 引擎显示名的唯一来源；原生引擎统一为「YCode」（与 TaskClientLogo、输入框占位文案一致）。 */
export const ENGINE_LABELS: Record<SessionEngine, string> = {
  zcode: "YCode",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export interface TaskClientLogoProps {
  engine?: SessionEngine;
  /** `compact` 为 14px（Composer 模型入口），缺省 16px。 */
  size?: "default" | "compact";
}

export interface EngineSwitchRowProps {
  engine: SessionEngine;
  /** 仅新草稿 + 本地工作区提供；缺省时只读显示当前引擎（已有会话）。 */
  onSelectEngine?: (engine: SessionEngine) => void;
  disabled?: boolean;
}

export interface EngineConnectionChoice {
  id: string;
  name: string;
  /** 方式与网关说明，用于悬停提示。 */
  description?: string;
}

export interface EngineControlsProps {
  engine: SessionEngine;
  /** 只拆分同一个 owner 的展示节点，不复制配置或 picker 状态。 */
  renderLayout?: (slots: { leadingActions: ReactNode; modelControls: ReactNode }) => ReactNode;
  /**
   * 模型入口弹层顶部的引擎切换行（SessionPane 构建的唯一 `EngineSwitchRow` 节点）；远程/Web 不传。
   * 传入时入口按钮不随原生配置禁用，保证草稿连接中/失败时仍能切换引擎。
   */
  engineSwitchRow?: ReactNode;
  options?: EngineConfigOption[];
  /** 返回 false 表示提交失败，控件撤销该次局部显示；确认配置仍只读 snapshot。 */
  onConfigChange?: (configId: string, value: string) => void | Promise<boolean>;
  disabled?: boolean;
  /** 已有会话连接中：显示连接中文案，原生配置不可写。 */
  loading?: boolean;
  /** 草稿原生配置就绪前：只禁用原生配置选择器，不显示连接中文案；引擎仍可改选，连接在设置页管理。 */
  configPending?: boolean;
  error?: string;
  connectionFailure?: EngineConnectionFailure;
  onRetry?: () => void;
  /** 连接 owner 的兼容输入；Composer 不展示连接入口。 */
  connectionChoices?: EngineConnectionChoice[];
  /** 当前草稿或会话绑定的配置 ID。 */
  connectionProfileId?: string;
  /** 仅草稿提供：选择后由草稿 owner 重建预热。 */
  onSelectConnection?: (profileId: string) => void;
  /** 绑定说明兼容输入；Composer 不显示。 */
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
