import { describe, expect, it } from "vitest";
import { createRegistryProviderConfig, parseProviderConfig, isApiKeyAccess } from "../src/index.js";

describe("历史 Coding Plan Key 兼容读取", () => {
  it("历史套餐 Key 保留原类型和磁盘材料，但不获得执行或普通 Key 编辑准入", () => {
    const base = parseProviderConfig({
      group: "standard-personal",
      access: {
        type: "zhipu-coding-plan-api-key",
        apiKeyManagementUrl: "https://z.ai/manage-apikey/apikey-list",
      },
      api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
    });
    expect(createRegistryProviderConfig(base).ok).toBe(false);
    const configured = base.overlay(
      parseProviderConfig({ access: { type: "zhipu-coding-plan-api-key", apiKey: "id.secret" } }),
    );
    const result = createRegistryProviderConfig(configured);
    expect(result.ok).toBe(false);
    expect(isApiKeyAccess(configured.access)).toBe(false);
    expect(configured.toJSON().access).toEqual({ ...base.toJSON().access, apiKey: "id.secret" });
    expect(parseProviderConfig(configured.toJSON()).toJSON()).toEqual(configured.toJSON());
    expect(() =>
      parseProviderConfig({ access: { type: "zhipu-coding-plan-api-key", entitled: true } }),
    ).toThrow();
    expect(() =>
      parseProviderConfig({
        access: { type: "zhipu-coding-plan-api-key", apiKeyManagementUrl: "invalid" },
      }),
    ).toThrow();
    expect(
      configured
        .overlay(parseProviderConfig({ access: { type: "api-key", apiKey: "ordinary" } }))
        .toJSON().access,
    ).toEqual({ type: "api-key", apiKey: "ordinary" });
  });

  it.each(["api-key", "zhipu-coding-plan-api-key"])(
    "%s 只允许单一管理入口，不接受已撤销的团队字段",
    (type) => {
      expect(() =>
        parseProviderConfig({
          access: { type, teamApiKeyManagementUrl: "https://example.com/keys" },
        }),
      ).toThrow();
      const base = parseProviderConfig({
        access: { type, apiKey: "fixture-key", apiKeyManagementUrl: "https://example.com/keys" },
      });
      const replaced = base.overlay(
        parseProviderConfig({
          access: { type, apiKeyManagementUrl: "https://example.com/console" },
        }),
      );
      expect(replaced.toJSON().access).toEqual({
        type,
        apiKey: "fixture-key",
        apiKeyManagementUrl: "https://example.com/console",
      });
      expect(
        replaced
          .overlay(parseProviderConfig({ access: { type, apiKeyManagementUrl: null } }))
          .toJSON().access,
      ).toEqual({ type, apiKey: "fixture-key", apiKeyManagementUrl: null });
    },
  );
});
