/**
 * conversation-presentation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { ClassifyAssistantMedia, ExtractConversationDeliverables } from "./contract.js";

export function exampleMediaClassification(classify: ClassifyAssistantMedia): string | undefined {
  return classify("https://example.invalid/download", "audio/wav")?.mediaType;
}

export function exampleConversationPresentation(
  extract: ExtractConversationDeliverables,
  rows: readonly AssistantTextRow[],
): readonly string[] {
  return extract(rows).map((reference) => reference.target);
}

/** 无 React/Host 的连续服务投影消费方。 */
export function exampleConversationMcpGroups(
  build: import("./contract.js").BuildConversationMcpGroups,
): number {
  return build([]).length;
}
