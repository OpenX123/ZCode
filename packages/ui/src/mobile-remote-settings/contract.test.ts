import { describe, expect, it } from "vitest";
import { mobileRemoteSectionPropsExample } from "./contract.example.js";
import { mobileRemoteSettingsModule } from "./module.js";

describe("mobile-remote-settings contract", () => {
  it("declares its module manifest", () => {
    expect(mobileRemoteSettingsModule.id).toBe("mobile-remote-settings");
    expect(Object.keys(mobileRemoteSectionPropsExample)).toHaveLength(0);
  });
});
