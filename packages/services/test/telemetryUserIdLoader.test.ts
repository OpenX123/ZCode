import { describe, expect, it } from "vitest";

describe("退役账号遥测 loader", () => {
  it("root/node 入口不再提供读取旧账号身份的 loader", async () => {
    const entries = await Promise.all([import("@zcode/services"), import("@zcode/services/node")]);
    for (const entry of entries) expect(entry).not.toHaveProperty("createTelemetryUserIdLoader");
  });
});
