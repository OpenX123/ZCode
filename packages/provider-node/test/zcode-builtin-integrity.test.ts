import { readFile } from "node:fs/promises";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  parseModelConfig,
} from "@zcode/provider";
import { describe, expect, it } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";

// 发布验证必须指向最终上传的那份文件，而不是默认悄悄检查仓库源文件。
const zcodeBuiltinProviderConfigFilePath =
  process.env.ZCODE_BUILTIN_RELEASE_TEST_FILE?.trim() ||
  fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url));

function reasoningPatch(map: string, reasoningLevel: string) {
  return compileModelOptionMaps({ reasoningLevel: { map }, maxOutputTokens: { map: "{}" } }).apply(
    {},
    { reasoningLevel, maxOutputTokens: 32000 },
  );
}

describe("ZCode Built-in Provider Config 完整性", () => {
  it.each(["anthropic-messages", "openai-chat-completions", "openai-responses"] as const)(
    "未知模型在 %s 下拥有完整两档兜底并可进入 Registry",
    async (apiType) => {
      const source = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: zcodeBuiltinProviderConfigFilePath,
        watch: false,
      });
      try {
        const snapshot = await source.read();
        const model = snapshot.models.resolve({
          providerId: "unknown-provider",
          modelId: "future-unknown-model",
          apiType,
          baseUrl: "https://unknown.example/v1",
        });
        expect(model.validateComplete()).toEqual([]);
        expect(model.optionSpecs?.maxOutputTokens?.max).toBe(128_000);
        expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
        expect(model.properties?.inputFormat.supportsImage).toBe(false);
        const result = new ProviderConfigResolver().resolve({
          zcodeBuiltinProviders: snapshot.providers,
          zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
          zcodeBuiltinModelRules: snapshot.models,
          personalModels: ModelConfigRules.empty(),
          personalProviders: new ProviderConfigMap([
            [
              "unknown-provider",
              new ProviderConfig({
                group: "standard-personal",
                api: new ProviderApiConfig({
                  type: apiType,
                  baseUrl: "https://unknown.example/v1",
                }),
                access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
                personalModelIds: ["future-unknown-model"],
              }),
            ],
          ]),
        });
        expect(
          result.registryProviders
            .find((entry) => entry.providerId === "unknown-provider")
            ?.models.map((entry) => entry.modelId),
        ).toContain("future-unknown-model");
      } finally {
        source.dispose();
      }
    },
  );
  it("GLM-5.3-Flash 的媒体输入能力与普通 API 模板保持明确", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const rawRelease = JSON.parse(await readFile(zcodeBuiltinProviderConfigFilePath, "utf8")) as {
        revision: number;
        config: { modelConfigRules: Record<string, unknown> };
      };
      expect(rawRelease.config.modelConfigRules).toMatchObject({
        modelRules: expect.any(Array),
        modelApiRules: expect.any(Array),
        providerSiteRules: expect.any(Array),
        templateModelRules: expect.any(Array),
        builtinProviderModelRules: expect.any(Array),
      });
      expect(rawRelease.config.modelConfigRules).not.toHaveProperty("matchRules");
      expect(snapshot.revision).toMatch(
        new RegExp(`^zcode-builtin:${rawRelease.revision}:[a-f0-9]{64}$`, "u"),
      );
      const apiTemplateIds = ["zai-standard-api", "bigmodel-standard-api"] as const;
      for (const templateId of apiTemplateIds) {
        const modelIds = snapshot.providerTemplates?.get(templateId)?.config.builtinModelIds ?? [];
        expect(modelIds, `${templateId} 必须同时提供 GLM-5.3 系列`).toEqual(
          expect.arrayContaining(["GLM-5.3", "GLM-5.3-Flash"]),
        );
      }
      const resolve = (modelId: string) =>
        snapshot.models.resolve({
          providerId: "personal-zai",
          templateId: "zai-standard-api",
          modelId,
          apiType: "anthropic-messages",
          // 模型层自身能力与 §6.3.1 已批准的站点覆盖分开验证。
          baseUrl: "https://other.example.com/anthropic",
        });
      const glm53 = resolve("glm-5.3").toJSON();
      const glm53Flash = resolve("glm-5.3-flash").toJSON();

      expect(glm53.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "high", "max"],
      });
      expect(glm53.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(glm53.optionSpecs!.reasoningLevel!.map!, "low")).toMatchObject({
        output_config: { effort: "low" },
      });
      expect(glm53.properties?.inputFormat).toMatchObject({
        supportsImage: false,
        supportsVideo: false,
      });

      expect(glm53Flash).toEqual({
        ...glm53,
        properties: {
          ...glm53.properties,
          inputFormat: {
            ...glm53.properties?.inputFormat,
            supportsImage: true,
            supportsVideo: true,
            supportsPdf: true,
          },
        },
      });
      const glm53FlashChat = snapshot.models.resolve({
        providerId: "personal-zai",
        templateId: "zai-standard-api",
        modelId: "glm-5.3-flash",
        apiType: "openai-chat-completions",
        baseUrl: "https://api.z.ai/api/anthropic",
      });
      expect(glm53FlashChat.properties?.inputFormat.supportsPdf).toBe(true);
    } finally {
      source.dispose();
    }
  });

  it("按当前官方证据声明各厂商主推模型和关键静态属性", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      expect(
        snapshot.providerTemplates?.get("moonshot-kimi")?.config.builtinModelIds.slice(0, 3),
      ).toEqual(["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"]);
      expect(
        snapshot.providerTemplates?.get("minimax")?.config.builtinModelIds.slice(0, 3),
      ).toEqual(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);
      for (const providerId of ["qwen-alibaba-model-studio-cn", "qwen-alibaba-model-studio-intl"]) {
        expect(
          snapshot.providerTemplates?.get(providerId)?.config.builtinModelIds.slice(0, 2),
        ).toEqual(["qwen3.8-max", "qwen3.8-flash"]);
      }
      expect(snapshot.providerTemplates?.get("openai")?.config.builtinModelIds.slice(0, 4)).toEqual(
        ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      );

      const resolve = (
        providerId: string,
        modelId: string,
        apiType: "anthropic-messages" | "openai-chat-completions" | "openai-responses",
        baseUrl: string,
      ) => snapshot.models.resolve({ providerId, modelId, apiType, baseUrl });

      const qwen38 = resolve(
        "qwen-alibaba-model-studio-intl",
        "qwen3.8-flash",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      );
      expect(qwen38.properties?.toJSON()).toMatchObject({
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
          supportsAudio: false,
          supportsPdf: false,
        },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
      });
      expect(qwen38.optionSpecs?.maxOutputTokens).toMatchObject({
        max: 131_072,
      });

      const mimo = resolve(
        "xiaomi-mimo",
        "mimo-v2.5",
        "anthropic-messages",
        "https://api.xiaomimimo.com/anthropic",
      );
      expect(mimo.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
      });

      const kimiCode = resolve(
        "moonshot-kimi",
        "kimi-k2.7-code",
        "anthropic-messages",
        "https://api.moonshot.cn/anthropic",
      );
      expect(kimiCode.properties?.contextWindow).toBe(262_144);
      expect(kimiCode.properties?.inputFormat.toJSON()).toMatchObject({
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
      });

      const kimiK3 = resolve(
        "moonshot-kimi",
        "kimi-k3",
        "anthropic-messages",
        "https://api.moonshot.cn/anthropic",
      );
      expect(kimiK3.properties?.toJSON()).toMatchObject({
        contextWindow: 1_048_576,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
        },
      });

      const kimiK3Compact = resolve(
        "moonshot-kimi",
        "k3-256k",
        "anthropic-messages",
        "https://api.kimi.com/coding/",
      );
      expect(kimiK3Compact.properties?.toJSON()).toMatchObject({
        contextWindow: 262_144,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
        },
      });

      const minimax = resolve(
        "minimax",
        "MiniMax-M2.7",
        "anthropic-messages",
        "https://api.minimaxi.com/anthropic",
      );
      expect(minimax.properties?.toJSON()).toMatchObject({
        contextWindow: 204_800,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
        },
      });

      const minimaxM3 = resolve(
        "minimax",
        "MiniMax-M3",
        "anthropic-messages",
        "https://api.minimaxi.com/anthropic",
      );
      expect(minimaxM3.properties?.toJSON()).toMatchObject({
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
        },
      });
    } finally {
      source.dispose();
    }
  });

  it("聚合供应商按维护清单提供独立模板，不复用上游 Provider 配置", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const openrouter = snapshot.providerTemplates?.get("openrouter")?.config;
      expect(openrouter?.api?.type).toBe("anthropic-messages");
      expect(openrouter?.api?.baseUrl).toBe("https://openrouter.ai/api");
      expect(openrouter?.builtinModelIds).toEqual(
        expect.arrayContaining(["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "z-ai/glm-5.3"]),
      );
      for (const templateId of [
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]) {
        expect(snapshot.providerTemplates?.has(templateId)).toBe(true);
      }
    } finally {
      source.dispose();
    }
  });

  it("聚合供应商同型号命中模型规则和 API Map，保留完整 ID 且每家至少启用一个代表型号", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const pairs = [
        ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
        ["anthropic/claude-opus-5", "claude-opus-5"],
        ["anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001"],
        ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
        ["moonshotai/kimi-k3", "kimi-k3"],
        ["z-ai/glm-5.3", "glm-5.3"],
        ["qwen/qwen3.8-max", "qwen3.8-max"],
        ["minimax/minimax-m3", "MiniMax-M3"],
        ["xiaomi/mimo-v2.5-pro", "mimo-v2.5-pro"],
        ["x-ai/grok-4.6", "grok-4.6"],
      ];
      for (const [aggregateId, directId] of pairs) {
        const resolve = (modelId: string, templateId?: string) =>
          snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: "anthropic-messages",
            baseUrl: "https://openrouter.ai/api",
          });
        const aggregate = resolve(aggregateId!, "openrouter");
        const direct = resolve(directId!);
        expect(aggregate.properties?.toJSON(), aggregateId).toEqual(direct.properties?.toJSON());
        expect(aggregate.optionSpecs?.toJSON(), aggregateId).toEqual(direct.optionSpecs?.toJSON());
      }
      for (const templateId of ["openrouter", "opencode-zen-messages", "opencode-zen-chat"]) {
        const template = snapshot.providerTemplates!.get(templateId)!.config;
        const enabledByVendor = new Map<string, boolean>();
        for (const modelId of template.builtinModelIds!) {
          const vendor =
            templateId === "openrouter" ? modelId.split("/")[0]! : modelId.split("-")[0]!;
          const model = snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: template.api!.type,
            baseUrl: template.api!.baseUrl,
          });
          enabledByVendor.set(
            vendor,
            (enabledByVendor.get(vendor) ?? false) || model.enabled === true,
          );
        }
        for (const [vendor, enabled] of enabledByVendor)
          expect(enabled, `${templateId}/${vendor}`).toBe(true);
      }
      const haiku = snapshot.models.resolve({
        providerId: "zen",
        templateId: "opencode-zen-messages",
        modelId: "claude-haiku-4-5",
        apiType: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen/v1",
      });
      expect(haiku.properties?.inputFormat.supportsImage).toBe(true);
      expect(haiku.properties?.contextWindow).toBe(200_000);
    } finally {
      source.dispose();
    }
  });

  it("每个 Provider 的默认 enabled 模型形成成员前缀，历史或 alias 型号默认关闭", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const exactEnabled = new Map(
        snapshot.models
          .rules()
          .flatMap((rule) =>
            rule.config.enabled === undefined ||
            (rule.type !== "provider-model" && rule.type !== "template-model")
              ? []
              : [
                  [
                    `${rule.type === "provider-model" ? rule.providerId : rule.templateId}\0${rule.modelId}`,
                    rule.config.enabled,
                  ] as const,
                ],
          ),
      );

      const memberships = [
        ...snapshot.providers.entries(),
        ...(snapshot.providerTemplates
          ?.entries()
          .map(([id, template]) => [id, template.config] as const) ?? []),
      ];
      for (const [ownerId, owner] of memberships) {
        const states = (owner.builtinModelIds ?? []).map((modelId) => {
          const enabled = exactEnabled.get(`${ownerId}\0${modelId}`);
          expect(enabled, `${ownerId}/${modelId} 必须显式声明 Built-in 默认 enabled`).toBeTypeOf(
            "boolean",
          );
          return enabled!;
        });
        const firstDisabled = states.indexOf(false);
        if (firstDisabled >= 0) {
          expect(
            states.slice(firstDisabled).every((enabled) => !enabled),
            `${ownerId} 的 enabled 成员必须在 disabled 成员之前`,
          ).toBe(true);
        }
      }

      expect(exactEnabled.get("openai\0gpt-5.6")).toBe(false);
      expect(exactEnabled.get("openai\0gpt-5.6-sol")).toBe(true);
      expect(exactEnabled.get("minimax\0MiniMax-M3")).toBe(true);
      expect(exactEnabled.get("xai\0grok-4.3")).toBe(false);
    } finally {
      source.dispose();
    }
  });

  it("随包只声明普通 API 模板，不预设官方账号 Provider", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      expect(snapshot.providers.keys()).toEqual([]);
      expect(snapshot.providerTemplates?.keys()).toEqual([
        "zai-standard-api",
        "bigmodel-standard-api",
        "moonshot-kimi",
        "minimax",
        "deepseek",
        "qwen-alibaba-model-studio-cn",
        "qwen-alibaba-model-studio-intl",
        "xiaomi-mimo",
        "xiaomi-mimo-token-plan",
        "openai",
        "anthropic",
        "xai",
        "openrouter",
        "opencode-go-chat",
        "opencode-go-messages",
        "opencode-go-responses",
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]);
      for (const [templateId, template] of snapshot.providerTemplates?.entries() ?? []) {
        expect(
          template.templateNameMap["zh-CN"]?.trim(),
          `${templateId} 缺少中文 Template 名称`,
        ).toBeTruthy();
        expect(
          template.templateNameMap["en-US"]?.trim(),
          `${templateId} 缺少英文 Template 名称`,
        ).toBeTruthy();
        expect(template.config.logo, `${templateId} 缺少 Built-in Logo 引用`).toMatchObject({
          type: "builtin",
        });
      }
      const expectedModelIds = new Map<string, string[]>();
      const personalProviders: ConstructorParameters<typeof ProviderConfigMap>[0] = [];
      for (const [templateId, template] of snapshot.providerTemplates?.entries() ?? []) {
        const providerId = `template:${templateId}`;
        const builtinModelIds = template.config.builtinModelIds ?? [];
        expect(new Set(builtinModelIds).size, `${templateId} 存在重复 Template 模型成员`).toBe(
          builtinModelIds.length,
        );
        const enabledModelIds = builtinModelIds.filter((modelId) => {
          const model = snapshot.models.resolve({
            providerId,
            templateId,
            modelId,
            apiType: template.config.api?.type,
            baseUrl: template.config.api?.baseUrl,
          });
          expect(model.validateComplete(["templates", templateId, "models", modelId])).toEqual([]);
          return model.enabled !== false;
        });
        expectedModelIds.set(providerId, enabledModelIds);
        expect(["api-key", "zhipu-coding-plan-api-key"]).toContain(template.config.access?.type);
        expect(template.config.access?.apiKey, `${templateId} 不得保存 API Key`).toBeUndefined();
        personalProviders.push({
          providerId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({
              type: template.config.access?.type,
              apiKey: `test-key-for-${templateId}`,
            }),
          }),
        });
      }

      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: snapshot.providers,
        zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
        personalProviders: new ProviderConfigMap(personalProviders),
        zcodeBuiltinModelRules: snapshot.models,
        personalModels: ModelConfigRules.empty(),
      });

      expect(resolution.issues).toEqual([]);
      expect(resolution.registryProviders.map(({ providerId }) => providerId)).toEqual([
        "template:zai-standard-api",
        "template:bigmodel-standard-api",
        "template:moonshot-kimi",
        "template:minimax",
        "template:deepseek",
        "template:qwen-alibaba-model-studio-cn",
        "template:qwen-alibaba-model-studio-intl",
        "template:xiaomi-mimo",
        "template:xiaomi-mimo-token-plan",
        "template:openai",
        "template:anthropic",
        "template:xai",
        "template:openrouter",
        "template:opencode-go-chat",
        "template:opencode-go-messages",
        "template:opencode-go-responses",
        "template:opencode-zen-responses",
        "template:opencode-zen-messages",
        "template:opencode-zen-chat",
      ]);

      for (const provider of resolution.registryProviders) {
        expect(
          provider.models.map(({ modelId }) => modelId),
          `${provider.providerId} 的 Registry 模型成员必须与 Built-in Config 一致`,
        ).toEqual(expectedModelIds.get(provider.providerId));
        for (const model of provider.models) {
          expect(
            model.config.validateComplete([
              "providers",
              provider.providerId,
              "models",
              model.modelId,
            ]),
          ).toEqual([]);
        }
      }

      for (const providerId of []) {
        const offPeak = resolution.resolvedProviders.find(
          (provider) => provider.providerId === providerId,
        );
        expect(offPeak?.models).not.toHaveLength(0);
        for (const model of offPeak?.models ?? []) {
          expect(model).toMatchObject({ executable: true, selectable: false });
        }
      }
    } finally {
      source.dispose();
    }
  });

  it("完整兜底让任意未知模型 ID 在各 API type 与模板下完整并进入 Registry（R3A-B-03）", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const fallbackRule = snapshot.models
        .rules()
        .find((rule) => rule.type === "model" && rule.modelMatch === ".*");
      const fallbackMax = fallbackRule?.config.optionSpecs?.maxOutputTokens?.max;
      expect(fallbackMax, "兜底规则必须声明 maxOutputTokens.max").toEqual(expect.any(Number));

      const unknownModelId = "b03-unknown-model-x";
      const scenarios = [
        { providerId: "custom-chat", apiType: "openai-chat-completions" as const },
        { providerId: "custom-messages", apiType: "anthropic-messages" as const },
        { providerId: "custom-responses", apiType: "openai-responses" as const },
        {
          providerId: "custom-deepseek",
          templateId: "deepseek",
          apiType: "openai-chat-completions" as const,
          baseURL: "https://api.deepseek.com",
          // 只能用目录默认启用的已知模型做探针：deepseek-v4-flash 已被 Built-in 目录标为
          // enabled:false，稀疏 Personal 规则不会覆盖它，Registry 里自然取不到。
          knownModelId: "deepseek-v4-pro",
        },
        {
          providerId: "custom-zai",
          templateId: "zai-standard-api",
          apiType: "anthropic-messages" as const,
          baseURL: "https://api.z.ai/api/anthropic",
          knownModelId: "glm-5.3",
        },
      ];
      const personalProviders = scenarios.map((scenario) => ({
        providerId: scenario.providerId,
        ...(scenario.templateId ? { templateId: scenario.templateId } : {}),
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: `test-key-for-${scenario.providerId}` }),
          api: new ProviderApiConfig({
            type: scenario.apiType,
            baseUrl: scenario.baseURL ?? "https://custom.example.com/v1",
          }),
          personalModelIds: [
            unknownModelId,
            ...(scenario.knownModelId ? [scenario.knownModelId] : []),
          ],
        }),
      }));
      // 设置页新增模型时 config-service 只写入 {enabled:true}，这里复用同一稀疏 Personal 规则。
      const personalModels = new ModelConfigRules(
        scenarios.map((scenario) => ({
          type: "provider-model" as const,
          providerId: scenario.providerId,
          modelId: unknownModelId,
          config: parseModelConfig({ enabled: true }),
        })),
      );
      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: ProviderConfigMap.empty(),
        zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
        personalProviders: new ProviderConfigMap(personalProviders),
        zcodeBuiltinModelRules: snapshot.models,
        personalModels,
      });
      const registry = new ProviderRegistry(resolution.registryProviders);

      expect(resolution.issues).toEqual([]);
      for (const scenario of scenarios) {
        const unknown = registry.getModel(scenario.providerId, unknownModelId);
        expect(unknown, `${scenario.providerId}/${unknownModelId} 应进入 Registry`).toBeDefined();
        expect(unknown?.config.optionSpecs.maxOutputTokens).toEqual({
          max: fallbackMax,
          map: expect.any(String),
        });
        if (scenario.knownModelId) {
          const known = registry.getModel(scenario.providerId, scenario.knownModelId);
          expect(
            known,
            `${scenario.providerId}/${scenario.knownModelId} 应进入 Registry`,
          ).toBeDefined();
          expect(known?.config.optionSpecs.maxOutputTokens.max).toEqual(expect.any(Number));
          // 新通用上限可与已知型号一致；已知型号仍由自身规则解析，不能以数值不同判断是否命中。
          expect(known?.config.optionSpecs.reasoningLevel.values).not.toEqual([
            "disabled",
            "enabled",
          ]);
        }
      }
    } finally {
      source.dispose();
    }
  });

  it("正式 Built-in JSON 不携带旧模型能力字段", async () => {
    const document = JSON.parse(
      await readFile(zcodeBuiltinProviderConfigFilePath, "utf8"),
    ) as unknown;
    const keys = collectObjectKeys(document);

    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("modalities");
    expect(keys).not.toContain("magic_name");
    expect(keys).not.toContain("supportsImages");
    // Todo104：supportsPdf/Video 是 inputFormat 内的正式字段，不能因同名误判成旧扁平能力。
    for (const key of [
      "input_format",
      "output_format",
      "support_text",
      "support_image",
      "support_pdf",
      "support_video",
      "support_audio",
    ]) {
      expect(keys).not.toContain(key);
    }
    expect(keys).not.toContain("budget_tokens");
    expect(keys).not.toContain("budgetTokens");
  });
});

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectObjectKeys(child)]);
}
