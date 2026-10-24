import { describe, expect, it } from "vitest";
import { normalizeZCodeEndpointOrigin, resolveBigModelApiOrigin } from "../src/zcodeEndpoint.js";
import { appSettingsSchema, appSettingsPatchSchema } from "../src/validationAppSettings.js";

describe("旧端点设置兼容与普通 API 来源", () => {
  it("旧设置只归一化origin，不生成官方服务URL", () => {
    expect(normalizeZCodeEndpointOrigin(" https://private.example/path?q=old ")).toBe(
      "https://private.example",
    );
    expect(
      appSettingsSchema.parse({ zcodeEndpointOrigin: "https://private.example/path" })
        .zcodeEndpointOrigin,
    ).toBe("https://private.example");
    expect(
      appSettingsPatchSchema.parse({ zcodeEndpointOrigin: "" }).zcodeEndpointOrigin,
    ).toBeUndefined();
  });
  it("拒绝非HTTP来源", () => {
    expect(() => normalizeZCodeEndpointOrigin("file:///private")).toThrow();
  });
  it("普通BigModel API保留用户显式来源", () => {
    expect(resolveBigModelApiOrigin({ BIGMODEL_API_BASE_URL: "https://gateway.example/v1" })).toBe(
      "https://gateway.example",
    );
    expect(resolveBigModelApiOrigin({})).toBe("https://bigmodel.cn");
  });
});
