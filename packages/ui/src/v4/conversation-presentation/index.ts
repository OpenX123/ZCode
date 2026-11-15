// 共享只读时间线会消费此入口；保持纯函数/类型，不导出带服务或平台依赖的组件。
export {
  extractConversationDeliverables,
  resolveConversationDeliverableIdentity,
  resolveConversationDeliverableKey,
} from "./conversationTurnDeliverables.js";
export type {
  ConversationDeliverable,
  ConversationDeliverableScope,
  ExtractConversationDeliverables,
} from "./contract.js";
