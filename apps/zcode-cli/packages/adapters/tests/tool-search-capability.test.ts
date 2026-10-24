import { describe, expect, it } from "vitest";
import { resolveToolSearchCapability } from "../src/model/tool-search.js";

describe("ToolSearch provider capability", () => {
  it("普通 API 不默认启用原生 ToolSearch，Anthropic 协议仍允许显式选择", () => {
    expect(resolveToolSearchCapability("anthropic-messages")).toEqual({
      protocolSupported: true,
      defaultEnabled: false,
    });
    for (const apiType of ["openai-chat-completions", "openai-responses"] as const) {
      expect(resolveToolSearchCapability(apiType)).toEqual({
        protocolSupported: false,
        defaultEnabled: false,
      });
    }
  });
});
