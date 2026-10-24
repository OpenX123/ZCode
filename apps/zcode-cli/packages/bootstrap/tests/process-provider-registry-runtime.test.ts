import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("process provider registry runtime", () => {
  it("独立 harness 启动忽略旧官方凭据和远端缓存，不请求官方配置", async () => {
    const root = await temporaryDirectory();
    const builtinPath = fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    );
    const credentialPath = join(root, ".zcode", "v2", "credentials.json");
    await mkdir(join(root, ".zcode", "v2"), { recursive: true });
    const activePath = join(root, "old-remote-cache.json");
    await writeFile(credentialPath, "旧官方凭据不得被读取或改写");
    await writeFile(activePath, "旧缓存即使损坏也不得用于运行");
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("禁止访问官方服务"));
    const runtime = await startProcessProviderRegistryRuntime(
      {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: activePath,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtinPath,
        ZCODE_DATA_BASE_DIR: root,
      },
      { standalone: { legacyCliUserConfigFilePath: join(root, "absent.json") } },
    );
    try {
      expect(request).not.toHaveBeenCalled();
      expect(runtime).not.toHaveProperty("providerRuntimeHeadersPort");
      expect(runtime).not.toHaveProperty("syncAccountProviderConfig");
      expect(await readFile(credentialPath, "utf8")).toBe("旧官方凭据不得被读取或改写");
      expect(await readFile(activePath, "utf8")).toBe("旧缓存即使损坏也不得用于运行");
    } finally {
      runtime.dispose();
    }
  });

  it("未注入 Provider Config 路径时拒绝启动", async () => {
    await expect(startProcessProviderRegistryRuntime({})).rejects.toThrow(
      "缺少进程 Provider Registry",
    );
  });

  it("Personal 文件损坏时保留原文件并以内存空配置启动", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(zcodeBuiltinRelease({ providers: {}, templates: {}, models: [] })),
    );
    await writeFile(personalFilePath, "{not-json");
    const started = await startProcessProviderRegistryRuntime({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });
    try {
      expect(started.configuredDefaultModelSelection).toBeUndefined();
      expect(await readFile(personalFilePath, "utf8")).toBe("{not-json");
      await expect(
        started.modelSelectionConfigRepository.saveConfiguredDefault(undefined),
      ).rejects.toThrow();
    } finally {
      started.dispose();
    }
    await expect(started.modelSelectionConfigRepository.read()).rejects.toThrow("已 dispose");
    await expect(started.runtime.start()).rejects.toThrow("已 dispose");
  });

  it("只有显式开启 Standalone 导入时才迁移旧 CLI 用户 Provider", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    const legacyFilePath = join(root, "legacy-cli.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(
        zcodeBuiltinRelease({
          providers: {},
          templates: {},
          // Personal Provider 仍由 Built-in 通用规则补齐静态模型事实；迁移器只搬运旧文件显式字段。
          models: [completeZCodeBuiltinModelRule()],
        }),
      ),
      "utf8",
    );
    await writeFile(
      legacyFilePath,
      JSON.stringify({
        model: "custom/model-a",
        provider: {
          custom: {
            kind: "anthropic",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com",
            },
            models: {
              "model-a": {
                limit: { context: 64_000, output: 8_000 },
              },
            },
          },
        },
      }),
      "utf8",
    );
    const env = {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    };

    // Protocol 启动会创建自己的空目标文件；若与 Standalone 共用目标，就会提前消费
    // “仅目标不存在时导入”的机会，无法再证明 Standalone importer 的独立边界。
    const protocolRuntime = await startProcessProviderRegistryRuntime({
      ...env,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "protocol-personal.json"),
    });
    expect(protocolRuntime?.snapshot.registry.providers).toEqual([]);
    expect(protocolRuntime?.configuredDefaultModelSelection).toBeUndefined();
    protocolRuntime?.dispose();

    const standaloneRuntime = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyFilePath },
    });
    expect(standaloneRuntime?.snapshot.registry.providers.map((entry) => entry.providerId)).toEqual(
      ["custom"],
    );
    expect(JSON.parse(await readFile(personalFilePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "custom", config: { access: { type: "api-key", apiKey: "secret" } } },
          ],
        },
      },
    });
    expect(standaloneRuntime?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    expect(
      JSON.parse(await readFile(personalFilePath, "utf8")).config.defaultModelSelection,
    ).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    standaloneRuntime?.dispose();

    const protocolRestart = await startProcessProviderRegistryRuntime(env);
    expect(protocolRestart?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    protocolRestart?.dispose();

    await writeFile(
      legacyFilePath,
      JSON.stringify({
        provider: {
          replacement: {
            kind: "anthropic",
            options: {
              apiKey: "replacement-secret",
              baseURL: "https://replacement.example.com",
            },
            models: {
              "model-b": { limit: { context: 32_000, output: 4_000 } },
            },
          },
        },
      }),
      "utf8",
    );
    const restarted = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyFilePath },
    });
    expect(restarted?.snapshot.registry.providers.map((entry) => entry.providerId)).toEqual([
      "custom",
    ]);
    expect(restarted?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    restarted?.dispose();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-process-provider-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeZCodeBuiltinModelRule() {
  return {
    modelMatch: ".*",
    config: {
      enabled: true,

      properties: {
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
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: {
          max: 32_000,
          map: '{"max_completion_tokens":maxOutputTokens}',
        },
      },
    },
  } as const;
}

function zcodeBuiltinRelease(input: {
  readonly providers: object;
  readonly templates: object;
  readonly models: readonly unknown[];
}): object {
  return {
    schemaVersion: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: 1,
    config: {
      providerConfigRules: {
        providerRules: Object.entries(input.providers).map(([providerId, config]) => ({
          providerId,
          config,
        })),
        templateRules: Object.entries(input.templates).map(([templateId, config]) => ({
          templateId,
          templateNameMap: { "en-US": templateId, "zh-CN": templateId },
          config,
        })),
      },
      modelConfigRules: {
        modelRules: input.models,
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

function personalRelease(providerRules: readonly unknown[]) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}
