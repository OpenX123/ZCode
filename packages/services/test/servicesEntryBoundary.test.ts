import { describe, expect, it } from "vitest";

describe("services package entry boundaries", () => {
  it("两个入口均不导出已退役官方分享 surface 或测试替身", async () => {
    const entries = await Promise.all([import("@zcode/services"), import("@zcode/services/node")]);
    for (const entry of entries) {
      for (const name of [
        "IConversationShareService",
        "ConversationShareService",
        "ConversationShareServiceError",
        "ConversationShareHttpClient",
        "ConversationShareMockApiClient",
        "conversationShareConnectionScopeFactory",
      ])
        expect(entry).not.toHaveProperty(name);
    }
  });

  it("保留普通服务 descriptor，Node 文件和凭据实现只由 node 入口导出", async () => {
    const [browserSafeEntry, nodeEntry] = await Promise.all([
      import("@zcode/services"),
      import("@zcode/services/node"),
    ]);
    expect(browserSafeEntry.IFileService.channelName).toBe("file");
    expect(browserSafeEntry.ICredentialService.channelName).toBe("credential");
    for (const name of [
      "createLocalServices",
      "createFileService",
      "createCredentialService",
    ] as const) {
      expect(browserSafeEntry).not.toHaveProperty(name);
      expect(nodeEntry[name]).toBeTypeOf("function");
    }
  });
});
