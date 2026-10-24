import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplateMap,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parsePersonalProviderConfigMap,
} from "../src/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

function completeModelConfig(
  patch: Partial<ConstructorParameters<typeof ModelPropertiesConfig>[0]> = {},
): ModelConfig {
  return new ModelConfig({
    enabled: true,

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      ...patch,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
  });
}

describe("ProviderConfigResolver", () => {
  it.each([
    [undefined, true, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
  ] as const)(
    "Provider enabled=%s、Key=%s、Model=%s 的集中准入",
    (enabled, key, modelEnabled, executable) => {
      const config = createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://example.com",
        apiKey: key ? "fixture" : "",
        models: ["m"],
      });
      const result = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: ProviderConfigMap.empty(),

        personalProviders: new ProviderConfigMap([{ providerId: "p", enabled, config }]),
        personalModels: ModelConfigRules.empty(),
        zcodeBuiltinModelRules: new ModelConfigRules([
          {
            type: "model",
            modelMatch: ".*",
            config: completeModelConfig().overlay(new ModelConfig({ enabled: modelEnabled })),
          },
        ]),
      });
      expect(result.resolvedProviders[0]?.enabled).toBe(enabled ?? true);
      expect(result.resolvedProviders[0]?.models).toHaveLength(1);
      expect(result.resolvedProviders[0]?.models[0]?.enabled).toBe(modelEnabled);
      expect(result.registryProviders.length > 0).toBe(executable);
    },
  );
  it("同 endpoint 的普通 API Provider 成员按身份隔离", () => {
    const api = {
      apiFormat: "anthropic-messages" as const,
      baseURL: "https://same.example/v1",
      apiKey: "test-only",
    };
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        ["first", createApiKeyProviderConfig({ ...api, models: ["shared", "first-only"] })],
        ["second", createApiKeyProviderConfig({ ...api, models: ["shared", "second-only"] })],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      personalModels: ModelConfigRules.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
    });
    expect(
      result.registryProviders.map((provider) => [
        provider.providerId,
        provider.models.map((model) => model.modelId),
      ]),
    ).toEqual([
      ["first", ["shared", "first-only"]],
      ["second", ["shared", "second-only"]],
    ]);
  });
  it("Registry 完整类型只由受校验入口创建", () => {
    const provider = createRegistryProviderConfig(new ProviderConfig({}), ["providers", "bad"]);
    const model = createRegistryModelConfig(new ModelConfig({}), [
      "providers",
      "bad",
      "models",
      "bad",
    ]);

    expect(provider).toMatchObject({ ok: false, issues: expect.any(Array) });
    expect(model).toMatchObject({ ok: false, issues: expect.any(Array) });
  });

  it("两个成员集合重名时 Built-in-wins，Personal 专属 Rule 继续后置覆盖", () => {
    const builtin = completeModelConfig({ contextWindow: 100_000 });
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "provider-a",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com/v1",
            }),
            builtinModelIds: ["model-a"],
          }),
        ],
      ]),
      personalProviders: new ProviderConfigMap([
        ["provider-a", new ProviderConfig({ personalModelIds: ["model-a"] })],
      ]),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "provider-model", providerId: "provider-a", modelId: "model-a", config: builtin },
      ]),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "provider-a",
          modelId: "model-a",
          config: new ModelConfig({
            // Personal 已只支持精确覆盖；不能用已裁决删除的全局 match 构造测试。
            properties: new ModelPropertiesConfig({
              contextWindow: 999_999,
              supportsToolCall: false,
            }),
          }),
        },
      ]),
    });

    const candidate = result.resolvedProviders[0]?.models[0];
    expect(candidate).toMatchObject({
      kind: "candidate",
      source: "builtin",
      executable: true,
      selectable: true,
    });
    expect(candidate?.kind === "candidate" && candidate.config.properties).toMatchObject({
      contextWindow: 999_999,
      supportsToolCall: false,
    });
    expect(result.registryProviders[0]?.models[0]?.config.properties.contextWindow).toBe(999_999);
  });

  it("无关的非法 Personal endpoint 不阻断同一文件中的合法 Provider", () => {
    const personalProviders = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "broken",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "broken-key" },
            api: { type: "openai-chat-completions", baseUrl: "testtest" },
            personalModelIds: ["broken-model"],
          },
        },
        {
          providerId: "valid",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "valid-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
            personalModelIds: ["valid-model"],
          },
        },
      ],
    });
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders,
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual(["valid"]);
    const brokenProvider = result.resolvedProviders.find(
      (provider) => provider.providerId === "broken",
    );
    expect(brokenProvider?.providerIssues.some((issue) => issue.code === "invalid-url")).toBe(true);
  });

  it("引用不存在 Template 的 Provider 不进入 Registry，并在全局诊断中保留问题", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
      personalProviders: new ProviderConfigMap([
        {
          providerId: "missing-template-provider",
          templateId: "missing-template",
          config: new ProviderConfig({ group: "standard-personal", personalModelIds: ["model-a"] }),
        },
      ]),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders).toEqual([]);
    expect(result.resolvedProviders[0]?.providerIssues).toContainEqual({
      code: "missing-template",
      path: ["providers", "missing-template-provider", "templateId"],
      message: "Provider Template 不存在: missing-template",
    });
    expect(result.issues).toContainEqual({
      code: "missing-template",
      path: ["providers", "missing-template-provider", "templateId"],
      message: "Provider Template 不存在: missing-template",
    });
  });

  it("隐藏 Provider 的启用模型仍进入 Registry，禁用模型只保留在 Settings Resolution", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "provider-a",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com/v1",
            }),
            builtinModelIds: ["enabled", "disabled"],
            visibility: "hidden",
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
        { type: "model", modelMatch: "disabled", config: new ModelConfig({ enabled: false }) },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual(["enabled"]);
    expect(result.resolvedProviders[0]?.models).toMatchObject([
      { modelId: "enabled", executable: true, selectable: false },
      { modelId: "disabled", executable: false, selectable: false },
    ]);
  });

  it("在唯一完整性边界收窄 Config，且 Registry 保留同一对象引用", () => {
    const providerConfig = new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://api.example.com/v1",
      }),
      builtinModelIds: ["model-a"],
    });
    const modelConfig = completeModelConfig();
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([["provider-a", providerConfig]]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: "model-a", config: modelConfig },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders[0]?.config).toBe(providerConfig);
    expect(result.effectiveBuiltinProviders.get("provider-a")).toBe(providerConfig);
    const resolvedModel = result.resolvedProviders[0]?.models[0];
    expect(result.registryProviders[0]?.models[0]?.config).toBe(
      resolvedModel?.kind === "candidate" ? resolvedModel.config : undefined,
    );
    expect(
      resolvedModel?.kind === "candidate" ? resolvedModel.effectiveBuiltinConfig : undefined,
    ).toEqual(modelConfig);
    expect(result.registryProviders[0]?.models[0]?.config.properties.requiresMfjsToolSchema).toBe(
      false,
    );
  });

  it("Built-in 规则按完整字符串匹配，并让后命中的规则覆盖前面的字段", () => {
    const resolver = new ProviderConfigResolver();
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "zai",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "anthropic-messages",
              baseUrl: "https://api.example.com",
            }),
            builtinModelIds: ["glm-5", "glm-50"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
        {
          type: "model",
          modelMatch: "glm-5",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
          }),
        },
        {
          type: "model",
          modelMatch: "glm-5",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ contextWindow: 1_000_000 }),
          }),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders[0]?.models[0]?.modelId).toBe("glm-5");
    expect(result.registryProviders[0]?.models[0]?.config.properties).toMatchObject({
      contextWindow: 1_000_000,
      inputFormat: expect.objectContaining({ supportsImage: true }),
    });
    expect(
      result.registryProviders[0]?.models[1]?.config.properties?.inputFormat?.supportsImage,
    ).toBe(false);
  });

  it("用 Effective Provider baseURL 解析 Endpoint 特化规则", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "provider-a",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com/v1",
            }),
            builtinModelIds: ["model-a"],
          }),
        ],
      ]),

      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
        {
          type: "provider-site",
          modelMatch: "model-a",
          baseUrlMatch: "https://api\\.example\\.com/v1",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ contextWindow: 1_000_000 }),
          }),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders[0]?.models[0]?.config.properties.contextWindow).toBe(1_000_000);
  });

  it("先应用模型通用 Option，再按 Provider 的 apiFormat 覆盖原始请求 map", () => {
    const resolver = new ProviderConfigResolver();
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "anthropic-provider",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "anthropic-messages",
              baseUrl: "https://anthropic.example.com",
            }),
            builtinModelIds: ["kimi-k3"],
          }),
        ],
        [
          "openai-provider",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-chat-completions",
              baseUrl: "https://openai.example.com",
            }),
            builtinModelIds: ["kimi-k3"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        {
          type: "model",
          modelMatch: "kimi-k3",
          config: completeModelConfig().overlay(
            new ModelConfig({
              optionSpecs: new ModelOptionSpecsConfig({
                reasoningLevel: {
                  values: ["low", "high"],
                },
              }),
            }),
          ),
        },
        {
          type: "model-api",
          modelMatch: "kimi-k3",
          apiTypeMatch: "anthropic-messages",
          config: new ModelConfig({
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                map: "{'thinking': {'type': reasoningLevel == 'high' ? 'enabled' : 'disabled'}}",
              },
            }),
          }),
        },
        {
          type: "model-api",
          modelMatch: "kimi-k3",
          apiTypeMatch: "openai-chat-completions",
          config: new ModelConfig({
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: { map: "{'reasoning_effort': reasoningLevel}" },
            }),
          }),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders[0]?.models[0]?.config.optionSpecs.reasoningLevel?.map).toBe(
      "{'thinking': {'type': reasoningLevel == 'high' ? 'enabled' : 'disabled'}}",
    );
    expect(result.registryProviders[1]?.models[0]?.config.optionSpecs.reasoningLevel?.map).toBe(
      "{'reasoning_effort': reasoningLevel}",
    );
  });

  it("只把完整 Provider 与启用 Model 发布到 Registry，并保留解析问题", () => {
    const resolver = new ProviderConfigResolver();
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "valid",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com",
            }),
            builtinModelIds: ["ok", "missing-config"],
          }),
        ],
        ["incomplete", new ProviderConfig({ group: "standard-personal", builtinModelIds: ["ok"] })],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: "ok", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual(["valid"]);
    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual(["ok"]);
    expect(result.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "providers.incomplete.access",
        "providers.incomplete.api",
        "providers.valid.models.missing-config.properties",
      ]),
    );
  });
});
