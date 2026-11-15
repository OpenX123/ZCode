/**
 * conversation-presentation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { ExtractConversationDeliverables } from "./contract.js";

export function exampleConversationPresentation(
  extract: ExtractConversationDeliverables,
  rows: readonly AssistantTextRow[],
): readonly string[] {
  return extract(rows).map((reference) => reference.contextText);
}
