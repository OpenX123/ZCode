import { describe, expect, it } from "vitest";
import { mobileRemoteGatewayDependenciesExample } from "./contract.example.js";
import { mobileRemoteGatewayModule } from "./module.js";

describe("mobile-remote-gateway contract", () => {
  it("declares its module manifest", () => {
    expect(mobileRemoteGatewayModule.id).toBe("mobile-remote-gateway");
  });

  it("窗口不可用时 attachWindow 返回 null", () => {
    expect(mobileRemoteGatewayDependenciesExample.attachWindow(1)).toBeNull();
    expect(mobileRemoteGatewayDependenciesExample.listWindows()[0]!.focused).toBe(true);
  });
});
