// 共享只读时间线会消费此入口；保持纯函数/类型，不导出带服务或平台依赖的组件。
export { classifyAssistantMedia, assistantPresentationReferences } from "./assistantMedia.js";
export { extractConversationDeliverables } from "./conversationTurnDeliverables.js";
export type {
  ClassifyAssistantMedia,
  AssistantPresentationReferences,
  ConversationDeliverable,
  ExtractConversationDeliverables,
} from "./contract.js";

export {
  buildConversationMcpGroups,
  readLegacyMcpToolPresentation,
  readConversationMcpServer,
  resolveConversationDisclosureKeys,
  isConversationMcpRowFailure,
} from "./conversationMcpGroups.js";
export type {
  ConversationMcpGroupItem,
  BuildConversationMcpGroups,
  ConversationDisclosureScope,
  DisclosureState,
  ConversationDisclosure,
  McpToolPresentation,
} from "./contract.js";
