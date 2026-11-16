import { describe, expect, it } from "vitest";
import * as protocol from "../src/zcode-protocol/index.js";

describe("退役官方 MCP 身份注入边界", () => {
  it("不再导出官方身份请求/响应 schema 或注册反向请求", () => {
    expect(protocol).not.toHaveProperty("zcodeOfficialMcpAuthHeadersRequestParamsSchema");
    expect(protocol).not.toHaveProperty("zcodeOfficialMcpAuthHeadersResponseSchema");
    expect(protocol.zcodeProtocolMethods).not.toHaveProperty(
      "interactionRequestOfficialMcpAuthHeaders",
    );
    expect(Object.values(protocol.zcodeProtocolMethods)).not.toContain(
      "interaction/requestOfficialMcpAuthHeaders",
    );
    expect(protocol.zcodeProtocolSessionMethodContracts).not.toHaveProperty(
      "interaction/requestOfficialMcpAuthHeaders",
    );
  });

  it.each(["http", "sse", "stdio"])("%s 协议拒绝旧官方鉴权声明，不能匿名降级", (type) => {
    const server =
      type === "stdio"
        ? { name: "tools", command: "tools", args: [], env: [] }
        : { name: "tools", type, url: "https://mcp.example.test/mcp", headers: [] };
    expect(protocol.zcodeProtocolMcpServerSchema.safeParse(server).success).toBe(true);
    expect(
      protocol.zcodeProtocolMcpServerSchema.safeParse({
        ...server,
        auth: { type: "zcode_official" },
      }).success,
    ).toBe(false);
  });
});
