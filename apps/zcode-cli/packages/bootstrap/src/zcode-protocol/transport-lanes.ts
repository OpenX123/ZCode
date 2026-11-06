import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMethods } from "@zcode/shared";
import { parseConversationTopic, V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

/**
 * CLI 传输的请求调度分类（规则见 docs/design/v2/zcode-protocol-agent-server.md「请求调度分道」）。
 *
 * 修复原因：一个 CLI 进程服务整个 workspace，过去除少数旁路外所有请求走同一条严格 FIFO，
 * A 会话的冷恢复会让 B 会话的订阅、行范围与工作区展示排队数秒到十几秒（1.0.5 生产日志
 * subscribeConversationV4 p90 13s、readWorkspacePresentation p90 18s）。现在按会话分道：
 * 同会话保序、跨会话并发；无会话的纯读收到即处理；其余无会话请求走全局分道。
 */
export type ProtocolLaneKind = "session" | "topic" | "model" | "global";

export type ProtocolDispatchPlan =
  /** 收到即处理：不排队，也不阻塞任何分道。 */
  | { kind: "immediate" }
  /** 控制面：等这些分道上最后一个请求进入 handler 后旁路执行，不等其完成。 */
  | { kind: "control"; laneKeys: readonly string[] }
  /** 进入分道：等这些分道的前序请求全部完成后开始，开始前后续同道请求都排在它后面。 */
  | { kind: "lane"; laneKind: ProtocolLaneKind; laneKeys: readonly string[] };

export const GLOBAL_PROTOCOL_LANE = "global";
const MODEL_PROTOCOL_LANE = "workspace-model";
const SESSION_LANE_PREFIX = "session:";
const TOPIC_LANE_PREFIX = "topic:";
const CREATE_SESSION_COMMAND_TYPE = "createSession";

/**
 * 无会话的纯读（以及只登记连接级流控状态的请求）：不依赖前序请求的执行结果，收到即处理。
 * 插件 list/describe/overview 沿用原有旁路理由（describe 写 manifest 自带 storage lock，
 * list/overview 同步执行不让出事件循环，seed 只在内容变化时写盘）；其余目录读取同理。
 * `provider/refreshRegistry` 不是纯读，但 Registry service 按 generation 合并并发刷新，
 * Host 在依赖它的请求之前已等待其响应，因此不需要传输层再串行。
 */
const IMMEDIATE_METHODS = new Set<string>([
  zcodeProtocolMethods.workspaceReadPresentation,
  zcodeProtocolMethods.sessionList,
  zcodeProtocolMethods.pluginsDescribe,
  zcodeProtocolMethods.pluginsList,
  zcodeProtocolMethods.pluginsOverview,
  zcodeProtocolMethods.pluginsReferenceCatalog,
  zcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
  zcodeProtocolMethods.pluginsListUiSurfaces,
  zcodeProtocolMethods.skillsReferenceCatalog,
  zcodeProtocolMethods.workflowsList,
  zcodeProtocolMethods.workflowsGet,
  zcodeProtocolMethods.workflowsRuns,
  zcodeProtocolMethods.workflowsForRun,
  zcodeProtocolMethods.usageStats,
  zcodeProtocolMethods.processChildProcesses,
  zcodeProtocolMethods.runtimeCapabilities,
  zcodeProtocolMethods.providerRefreshRegistry,
  V4_METHODS.sessionsIndexReconcile,
  V4_METHODS.usageStats,
  // 连接级流控（saturated/ready/closed）：同步更新本连接的投递状态，必须及时生效，
  // 不能排在长请求之后；它不读写任何会话状态。
  V4_METHODS.connectionFlow,
]);

// MCP App 的请求由实例凭证和 callId 隔离；若与普通命令一起等待完成，
// uiCallTool 会挡住自己的 cancel/close，真实 stdio 链路将死锁。
const MCP_APP_CONTROL_METHODS = new Set<string>([
  zcodeProtocolMethods.mcpReadResource,
  zcodeProtocolMethods.mcpUiOpenInstance,
  zcodeProtocolMethods.mcpUiCloseInstance,
  zcodeProtocolMethods.mcpUiValidateInstance,
  zcodeProtocolMethods.mcpUiCallTool,
  zcodeProtocolMethods.mcpUiSampling,
  zcodeProtocolMethods.mcpUiCancelSampling,
  zcodeProtocolMethods.mcpUiCancelCall,
  zcodeProtocolMethods.mcpUiReadResource,
  zcodeProtocolMethods.mcpUiListResources,
  zcodeProtocolMethods.mcpUiListResourceTemplates,
  zcodeProtocolMethods.mcpUiSubscribeResource,
  zcodeProtocolMethods.mcpUiUnsubscribeResource,
  zcodeProtocolMethods.mcpUiRegisterAppTools,
  zcodeProtocolMethods.mcpUiUnregisterAppTools,
  zcodeProtocolMethods.mcpUiClaimAppToolCall,
  zcodeProtocolMethods.mcpUiResolveAppToolCall,
]);

/** 无状态的长耗时模型/网络调用：彼此保序，但不阻塞全局写，也不被全局写阻塞。 */
const MODEL_LANE_METHODS = new Set<string>([
  zcodeProtocolMethods.workspaceGenerateText,
  zcodeProtocolMethods.providerTestModelConnectivity,
]);

/**
 * 根据一条入站消息决定调度方式。调用方已先处理 response 与网络观测通知；这里只看 request
 * 与其余通知。分类只读 method 与 params 中的会话标识，不解析业务 payload。
 */
export function planProtocolDispatch(message: ZCodeProtocolMessage): ProtocolDispatchPlan {
  if (!("method" in message)) return globalLane();
  const method = message.method;
  const params = "params" in message ? message.params : undefined;
  if (!("id" in message)) return globalLane();
  if (IMMEDIATE_METHODS.has(method) || isClockOnlyCommandsQuery(method, params)) {
    return { kind: "immediate" };
  }
  if (method === zcodeProtocolMethods.sessionStop || MCP_APP_CONTROL_METHODS.has(method)) {
    // 停止/取消必须等它前面的同会话请求真正进入 handler、建立 abort controller，再越过该请求的
    // 异步执行；只延后一轮微任务会让控制请求提前成为空操作。
    const laneKeys = collectSessionLaneKeys(method, params);
    return { kind: "control", laneKeys: laneKeys.length > 0 ? laneKeys : [GLOBAL_PROTOCOL_LANE] };
  }
  if (method === zcodeProtocolMethods.workspaceCancelGenerateText) {
    return { kind: "control", laneKeys: [MODEL_PROTOCOL_LANE] };
  }
  if (method === zcodeProtocolMethods.pluginsCancelOperation) {
    // 插件安装/更新在全局分道里可能持续数分钟；取消若与它们同道排队就永远等不到执行。
    return { kind: "control", laneKeys: [GLOBAL_PROTOCOL_LANE] };
  }
  if (MODEL_LANE_METHODS.has(method)) {
    return { kind: "lane", laneKind: "model", laneKeys: [MODEL_PROTOCOL_LANE] };
  }
  const sessionLaneKeys = collectSessionLaneKeys(method, params);
  if (sessionLaneKeys.length > 0) {
    return { kind: "lane", laneKind: "session", laneKeys: sessionLaneKeys };
  }
  const topicLaneKey = collectTopicLaneKey(params);
  if (topicLaneKey) return { kind: "lane", laneKind: "topic", laneKeys: [topicLaneKey] };
  return globalLane();
}

function globalLane(): ProtocolDispatchPlan {
  return { kind: "lane", laneKind: "global", laneKeys: [GLOBAL_PROTOCOL_LANE] };
}

/**
 * 会话分道键：params.sessionId、conversation topic、commands[].sessionId，以及 v4 命令信封的
 * sessionId 与 createSession 的 Host 预留 payload.sessionId。后者保证"创建 → 同会话订阅"即使
 * 客户端未等 ACK 也按到达顺序开始。
 */
function collectSessionLaneKeys(method: string, params: unknown): string[] {
  if (!isRecord(params)) return [];
  const sessionIds = new Set<string>();
  addSessionId(sessionIds, params.sessionId);
  if (typeof params.topic === "string") {
    const topicSessionId = parseConversationTopic(params.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(params.commands)) {
    for (const command of params.commands) {
      if (isRecord(command)) addSessionId(sessionIds, command.sessionId);
    }
  }
  if (
    method === V4_METHODS.command &&
    params.type === CREATE_SESSION_COMMAND_TYPE &&
    isRecord(params.payload)
  ) {
    addSessionId(sessionIds, params.payload.sessionId);
  }
  return [...sessionIds].sort().map((sessionId) => `${SESSION_LANE_PREFIX}${sessionId}`);
}

/** 非 conversation topic（sessions-index/*、workspace-config/*）的订阅族按 topic 保序。 */
function collectTopicLaneKey(params: unknown): string | undefined {
  if (!isRecord(params) || typeof params.topic !== "string") return undefined;
  const topic = params.topic.trim();
  return topic.length > 0 ? `${TOPIC_LANE_PREFIX}${topic}` : undefined;
}

/** `clock: true` 只是 TTFT 时钟探测，不触发命令账本查询、恢复或 admission gate。 */
function isClockOnlyCommandsQuery(method: string, params: unknown): boolean {
  return method === V4_METHODS.commandsQuery && isRecord(params) && params.clock === true;
}

function addSessionId(target: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) target.add(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
