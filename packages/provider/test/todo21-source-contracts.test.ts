import { describe, expect, it } from "vitest";
import {
  parsePersonalProviderConfigMap,
  parseZCodeBuiltinProviderConfigMap,
} from "../src/index.js";

describe("Todo 21 source contracts", () => {
  it("ZCode Built-in Provider 只接受 Account Family Provider", () => {
    const providers = parseZCodeBuiltinProviderConfigMap([
      {
        providerId: "builtin",
        config: {
          group: "zai-family",
          visibility: "visible",
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "individual-coding-plan",
          },
          api: { type: "anthropic-messages", baseUrl: "https://example.com" },
          builtinModelIds: ["model-a"],
        },
      },
    ]);

    expect(providers.get("builtin")?.group).toBe("zai-family");
    expect(() =>
      parseZCodeBuiltinProviderConfigMap([
        {
          providerId: "invalid",
          config: { group: "standard-personal", personalModelIds: ["model-a"] },
        },
      ]),
    ).toThrow();
    expect(() =>
      parseZCodeBuiltinProviderConfigMap([
        { providerId: "invalid", config: { access: { type: "api-key" } } },
      ]),
    ).toThrow();
  });

  it("Personal Provider 不能写 builtinModelIds，根 group 只能是 standard-personal", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "personal",
          config: {
            group: "standard-personal",
            personalModelIds: ["model-a"],
            modelOrder: ["model-a"],
          },
        },
        { providerId: "overlay", providerName: "Overlay", config: {} },
      ],
    });
    expect(providers.get("personal")?.modelOrder).toEqual(["model-a"]);
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "personal", config: { builtinModelIds: ["model-a"] } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "personal", config: { group: "standard-builtin" } }],
      }),
    ).toThrow();
  });

  it("Personal Provider 缺失 access 时保持不完整，不从 group 推断 Access", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        { providerId: "personal", config: { group: "standard-personal" } },
        { providerId: "overlay", providerName: "Overlay", config: {} },
      ],
    });

    expect(providers.get("personal")?.access).toBeUndefined();
    expect(providers.get("overlay")?.access).toBeUndefined();
  });

  it("智谱产品模式属于 Provider Access", () => {
    const providers = parseZCodeBuiltinProviderConfigMap([
      {
        providerId: "offpeak",
        config: {
          group: "zai-family",
          visibility: "hidden",
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "off-peak",
          },
          api: { type: "anthropic-messages", baseUrl: "https://example.com" },
          builtinModelIds: ["model-a"],
        },
      },
    ]);
    expect(providers.get("offpeak")?.access?.toJSON()).toEqual({
      type: "zhipu-account",
      accountType: "zai",
      mode: "off-peak",
    });
  });
});
