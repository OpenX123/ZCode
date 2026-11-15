import type {
  AssistantMediaRef,
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";

/** 显式 MIME 优先，其次共享扩展名；不探测网络、不读取文件。 */
export type ClassifyAssistantMedia = (
  source: string,
  mimeType?: string,
) => Pick<AssistantMediaRef, "mediaType" | "mimeType"> | null;
/** 已收到正文的纯展示引用，不构造持久化事实。 */
export type AssistantPresentationReferences = (
  text: string,
  streaming?: boolean,
) => readonly ConversationDeliverable[];

/** 仅引用已收到的正文/媒体；文本区间为 UTF-16 半开区间，typedMedia 用文尾零宽锚点。 */
export interface ConversationDeliverable {
  /** 实际来源锚点，只承担溯源；不能直接用作 React 挂载身份。 */
  readonly key: string;
  readonly sourceRowId: number;
  readonly start: number;
  readonly end: number;
  readonly kind: "link" | "image" | "file";
  readonly sourceFormat: "markdown" | "standaloneUrl" | "textFence" | "typedMedia";
  readonly target: string;
  /** 同源单项媒体引用；消费方不得把原行全部 media 复制到每个成果。 */
  readonly media?: AssistantMediaRef;
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

/** 按原始行序的展示投影，绝不改写执行或原生父子身份。 */
export type ConversationMcpGroupItem =
  | { readonly kind: "row"; readonly row: ConversationRow }
  | {
      readonly kind: "mcpGroup";
      readonly serverName: string;
      readonly rows: readonly ToolCallRow[];
    };
export type BuildConversationMcpGroups = (
  rows: readonly ConversationRow[],
) => readonly ConversationMcpGroupItem[];
export interface ConversationDisclosureScope extends ConversationDeliverableScope {}
export interface DisclosureState {
  readonly defaultOpen: boolean;
  readonly userOverride?: boolean;
}
export interface ConversationDisclosure {
  readonly keys: readonly string[];
  readonly defaultOpen: boolean;
}

/** discovery 与显式历史 envelope 的机械展示元数据；不参与执行/权限。 */
export interface McpToolPresentation {
  readonly kind: "mcp_tool";
  readonly serverName?: string;
  readonly toolName: string;
  readonly description?: string;
}
