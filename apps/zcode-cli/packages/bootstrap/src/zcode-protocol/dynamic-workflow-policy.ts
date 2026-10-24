import {
  zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 动态工作流策略由 Host 根据本地设置裁决，CLI 只缓存结论。
 * CLI 进程按 workspace 隔离，
 * 缓存一份即可；createRecord 对 legacy create/resume、v4 createSession 与 v4 冷恢复
 * （subscribe → resumePersistedSession，没有 host 参数通道）统一读取。
 * 只影响之后创建/恢复的 record；已活跃 record 的工具面不回收。
 */
export async function updateDynamicWorkflowPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.dynamicWorkflowEnabled = params.enabled;
  // mode 只在开启时有意义；关闭时清掉，下次仅发布尔时使用内置默认。
  context.appRuntimePreferences.dynamicWorkflowMode = params.enabled ? params.mode : undefined;
  return { workspace: params.workspace, enabled: params.enabled };
}

/** createRecord 写进 runtimeConfig 的工作流启用与按需激活字段。 */
export interface DynamicWorkflowRuntimeGate {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
}

/**
 * 本次 create / resume 参数优先，缺席时读 Host 同步到进程的 workspace 级结论；两者都没有就是关闭
 * （fail-closed）。mode 同序取值，都缺席时使用独立桌面的 onDemand 默认。
 * 两个字段必须写出显式布尔：core 把「缺席」定义为「立刻注册全部工具」
 * （TUI / headless / workflow_child 的语义），受信 Host 创建的会话不能落进那条豁免。
 */
export function resolveDynamicWorkflowRuntimeGate(
  params: { dynamicWorkflowEnabled?: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
  preferences: { dynamicWorkflowEnabled: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
): DynamicWorkflowRuntimeGate {
  const enabled = params.dynamicWorkflowEnabled === true || preferences.dynamicWorkflowEnabled;
  if (!enabled) return { dynamicWorkflowEnabled: false, dynamicWorkflowToolsOnDemand: false };
  const mode = params.dynamicWorkflowMode ?? preferences.dynamicWorkflowMode ?? "onDemand";
  return { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: mode === "onDemand" };
}
