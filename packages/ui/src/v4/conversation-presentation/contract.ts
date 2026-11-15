import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";

/** 仅引用已经收到的正文；区间为原行 UTF-16 半开区间，不解析或读取目标文件。 */
export interface ConversationDeliverable {
  readonly key: string;
  readonly sourceRowId: number;
  readonly start: number;
  readonly end: number;
  readonly kind: "link" | "image" | "file";
  readonly sourceFormat: "markdown" | "standaloneUrl" | "textFence";
  readonly target: string;
  /** 合并来源片段中仍需独立打开的 text fence 目标；省略时兼容单引用。 */
  readonly textFenceTargets?: readonly string[];
  readonly contextStart: number;
  readonly contextEnd: number;
  readonly contextText: string;
}

export interface ConversationDeliverableScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly workspaceRemoteSessionId?: string;
  readonly sessionId?: string | null;
  readonly logEpoch?: string;
}

/** 确定性、无 IO、无事件和持久化；只处理已加载行，按完整目标保留首次有效引用。 */
export type ExtractConversationDeliverables = (
  rows: readonly AssistantTextRow[],
) => readonly ConversationDeliverable[];
