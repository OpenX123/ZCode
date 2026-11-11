import { describe, expect, it } from "vitest";
import { mobileRemoteConnectExample } from "./contract.example.js";
import { MobileRemoteConnectError } from "./contract.js";
import { mobileRemoteClientModule } from "./module.js";

describe("mobile-remote-client contract", () => {
  it("declares its module manifest", () => {
    expect(mobileRemoteClientModule.id).toBe("mobile-remote-client");
  });

  it("示例默认接入聚焦窗口，错误带稳定 code", () => {
    expect(
      mobileRemoteConnectExample.chooseWindow([
        { windowId: 1, title: "a", focused: false },
        { windowId: 2, title: "b", focused: true },
      ]),
    ).toBe(2);
    expect(new MobileRemoteConnectError("host_offline", "x").code).toBe("host_offline");
  });
});
