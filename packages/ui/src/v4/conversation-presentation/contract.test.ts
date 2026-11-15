import { describe, expect, it } from "vitest";

import { conversationPresentationModule } from "./module.js";
import type { ConversationDeliverable, ExtractConversationDeliverables } from "./contract.js";
import { exampleConversationPresentation, exampleMediaClassification } from "./contract.example.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("conversation-presentation contract", () => {
  it("按同源 MIME 做纯媒体分类不依赖平台", () => {
    expect(exampleMediaClassification(() => ({ mediaType: "audio", mimeType: "audio/wav" }))).toBe(
      "audio",
    );
  });
  it("declares its module manifest", () => {
    expect(conversationPresentationModule.id).toBe("conversation-presentation");
    expect(conversationPresentationModule.requires).toEqual(["shared"]);
    expect(conversationPresentationModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });
  it("调用方仅需原行与来源契约，不需要 Host 或运行时", () => {
    const reference: ConversationDeliverable = {
      key: "1:0:1:link",
      sourceRowId: 1,
      start: 0,
      end: 1,
      kind: "link",
      sourceFormat: "markdown",
      target: "https://example.invalid",
      identityTargets: ["https://example.invalid"],
      contextStart: 0,
      contextEnd: 1,
      contextText: "打开入口",
    };
    const extract: ExtractConversationDeliverables = () => [reference];
    expect(exampleConversationPresentation(extract, [])).toEqual(["打开入口"]);
  });
});
