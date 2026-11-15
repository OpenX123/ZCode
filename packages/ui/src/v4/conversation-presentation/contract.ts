import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";

/** 仅引用已经收到的正文；区间为原行 UTF-16 半开区间，不解析或读取目标文件。 */
export interface ConversationDeliverable {
  /** 实际来源锚点，只承担溯源；不能直接用作 React 挂载身份。 */
  readonly key: string;
  readonly sourceRowId: number;
  readonly start: number;
  readonly end: number;
  readonly kind: "link" | "image" | "file";
  readonly sourceFormat: "markdown" | "standaloneUrl" | "textFence";
  readonly target: string;
  /** 跨来源去重和最终覆盖前的完整原始目标组；省略时为单 target。 */
  readonly identityTargets?: readonly string[];
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

/** 确定性、无 IO、无事件和持久化；保留已加载行的全部有效来源，供分组后去重。 */
export type ExtractConversationDeliverables = (
  rows: readonly AssistantTextRow[],
) => readonly ConversationDeliverable[];
