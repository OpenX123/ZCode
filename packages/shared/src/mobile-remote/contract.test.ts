import { describe, expect, it } from "vitest";
import { exampleMobileRemoteHandshake, mobileRemoteStatusExample } from "./contract.example.js";
import { mobileRemoteLinkModule } from "./module.js";

describe("mobile-remote-link contract", () => {
  it("declares its module manifest", () => {
    expect(mobileRemoteLinkModule.id).toBe("mobile-remote-link");
  });

  it("示例握手后发出一条加密 RPC 帧，状态示例符合合同", () => {
    const frames = exampleMobileRemoteHandshake();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(1 + 3 + 16);
    expect(mobileRemoteStatusExample.devices[0]!.connected).toBe(true);
  });
});
