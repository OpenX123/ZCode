import { describe, expect, it } from "vitest";
import { pairedHostExample } from "./contract.example.js";
import { mobileRemoteWebModule } from "./module.js";

describe("mobile-remote-web contract", () => {
  it("declares its module manifest", () => {
    expect(mobileRemoteWebModule.id).toBe("mobile-remote-web");
    expect(pairedHostExample.relayUrl.startsWith("https://")).toBe(true);
  });
});
