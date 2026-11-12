import { describe, expect, it } from "vitest";
import { relayOptionsExample } from "./contract.example.js";
import { RelayCloseCodes } from "./contract.js";
import { mobileRemoteRelayModule } from "./module.js";

describe("mobile-remote-relay contract", () => {
  it("declares its module manifest", () => {
    expect(mobileRemoteRelayModule.id).toBe("mobile-remote-relay");
  });

  it("关闭码与 spec 一致，示例必须配置令牌", () => {
    expect(RelayCloseCodes.hostOffline).toBe(4404);
    expect(RelayCloseCodes.acceptTimeout).toBe(4408);
    expect(relayOptionsExample.hostToken.length).toBeGreaterThanOrEqual(16);
  });
});
