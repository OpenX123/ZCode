import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import type { ModelProviderConfig } from "../src/model-provider/legacyModelProviderSerialized.js";
import { readLegacyZCodeConfigProviders } from "../src/model-provider/legacyZCodeConfigProviderReader.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { setDataBaseDir } from "../src/paths.js";

function legacyProvider(): ModelProviderConfig {
  return {
    id: "custom-provider",
    name: "Custom Provider",
    endpoints: { baseURL: "https://api.example.com" },
    apiFormat: "anthropic-messages",
    source: "custom",
    apiKey: "secret-key",
    models: [
      {
        id: "custom-model",
        kinds: ["anthropic"],
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        modalities: { input: ["text"], output: ["text"] },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function emptyBuiltinRelease(revision = 1) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  } as const;
}

describe("ProviderConfigRuntime", () => {
  it.each(["io", "json", "schema"] as const)(
    "旧配置 %s 失败不能提交空迁移，源文件恢复后仍可导入",
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-provider-import-failure-"));
      const configDir = join(root, ".zcode", "v2");
      const legacyFilePath = join(configDir, "config.json");
      const personalFilePath = join(configDir, "provider_config.json");
      const zcodeBuiltinFilePath = join(root, "builtin.json");
      const secret = "PRIVATE_KEY_MUST_NOT_APPEAR_IN_ERRORS";
      const invalidText =
        stage === "json"
          ? `{"apiKey":"${secret}","provider":`
          : JSON.stringify({ provider: { custom: { kind: secret } } });
      await mkdir(configDir, { recursive: true });
      await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyBuiltinRelease()));
      if (stage === "io") await mkdir(legacyFilePath);
      else await writeFile(legacyFilePath, invalidText);
      setDataBaseDir(root);
      const recovery = vi.fn();
      const runtime = createProviderConfigRuntime({
        zcodeBuiltinFilePath,
        readLegacyProviders: readLegacyZCodeConfigProviders,
        onPersonalConfigRecovery: recovery,
        personalPollingIntervalMs: false,
        watch: false,
      });
      try {
        await runtime.start();
        expect(recovery).toHaveBeenCalled();
        const error = recovery.mock.calls[0]?.[0].error as Error;
        expect(error.message).toContain(legacyFilePath);
        expect(error.message).toContain(`stage=${stage}`);
        expect(error.message).not.toContain(secret);
        expect(error.cause).toBeUndefined();
        await expect(readFile(personalFilePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          runtime.personalRepository.update(() => ({
            providers: ProviderConfigMap.empty(),
            models: ModelConfigRules.empty(),
          })),
        ).rejects.toThrow(`stage=${stage}`);
        await expect(readFile(personalFilePath)).rejects.toMatchObject({ code: "ENOENT" });
        if (stage === "io") await rm(legacyFilePath, { recursive: true });
        else await expect(readFile(legacyFilePath, "utf8")).resolves.toBe(invalidText);
        const repairedText = JSON.stringify({
          provider: {
            "custom-provider": {
              kind: "anthropic",
              options: {
                apiKey: secret,
                baseURL: "https://example.com/anthropic",
              },
              models: { "custom-model": {} },
            },
          },
        });
        await writeFile(legacyFilePath, repairedText);
        const snapshot = await runtime.configService.read();
        expect(snapshot.personalProviders.keys()).toEqual(["custom-provider"]);
        expect(snapshot.personalProviders.get("custom-provider")?.toJSON()).toMatchObject({
          access: { apiKey: secret },
          personalModelIds: ["custom-model"],
        });
        await expect(readFile(personalFilePath, "utf8")).resolves.toContain("custom-provider");
        await expect(readFile(legacyFilePath, "utf8")).resolves.toBe(repairedText);
      } finally {
        runtime.dispose();
        setDataBaseDir(null);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("旧配置不存在时仍可初始化空 Personal 配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-new-install-"));
    const zcodeBuiltinFilePath = join(root, "builtin.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyBuiltinRelease()));
    setDataBaseDir(root);
    const recovery = vi.fn();
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      readLegacyProviders: readLegacyZCodeConfigProviders,
      onPersonalConfigRecovery: recovery,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      await runtime.start();
      expect((await runtime.configService.read()).personalProviders.keys()).toEqual([]);
      expect(recovery).not.toHaveBeenCalled();
      await expect(
        readFile(join(root, ".zcode/v2/provider_config.json"), "utf8"),
      ).resolves.toContain('"schemaVersion": 1');
    } finally {
      runtime.dispose();
      setDataBaseDir(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("保留含非法 endpoint 的 Personal Provider，并把问题留给 Registry 完整性校验", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-"));
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const personalFilePath = join(root, "provider_config.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyBuiltinRelease()), "utf8");
    await writeFile(
      personalFilePath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
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
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
      "utf8",
    );

    const recovery = vi.fn();
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      personalPollingIntervalMs: false,
      watch: false,
      onPersonalConfigRecovery: recovery,
    });

    try {
      await runtime.start();
      const snapshot = await runtime.configService.read();
      expect(snapshot.personalProviders.keys()).toEqual(["broken", "valid"]);
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
    }
  });

  it("从旧 config.json 导入同目录 provider_config.json，不改写旧文件且不备份", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-"));
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const configDir = join(root, ".zcode", "v2");
    const legacyFilePath = join(configDir, "config.json");
    const legacyText = JSON.stringify({
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          options: { baseURL: "https://api.example.com", apiKey: "secret-key" },
          models: { "custom-model": {} },
        },
      },
    });
    await mkdir(configDir, { recursive: true });
    await writeFile(legacyFilePath, legacyText, "utf8");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyBuiltinRelease()), "utf8");
    setDataBaseDir(root);
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      readLegacyProviders: readLegacyZCodeConfigProviders,
      watch: false,
    });
    try {
      await runtime.start();
      const snapshot = await runtime.configService.read();

      await expect(
        readFile(join(root, ".zcode", "v2", "provider_config.json"), "utf8"),
      ).resolves.toContain('"schemaVersion": 1');
      expect(snapshot.personalProviders.keys()).toEqual(["custom-provider"]);
      await expect(readFile(legacyFilePath, "utf8")).resolves.toBe(legacyText);
      expect((await readdir(configDir)).some((name) => name.endsWith(".bak"))).toBe(false);
    } finally {
      runtime.dispose();
      setDataBaseDir(null);
    }
  });

  it("用注入的 ZCode Built-in Source 初始化，并在 Personal 文件缺失时单向导入旧配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-"));
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyBuiltinRelease()), "utf8");
    const readLegacyProviders = vi.fn(async () => [legacyProvider()]);
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      readLegacyProviders,
      watch: false,
    });

    await runtime.start();
    const snapshot = await runtime.configService.read();

    expect(readLegacyProviders).toHaveBeenCalledTimes(1);
    expect(snapshot.personalProviders.get("custom-provider")?.toJSON()).toMatchObject({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "secret-key" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://api.example.com",
      },
      personalModelIds: ["custom-model"],
      modelOrder: ["custom-model"],
    });
    expect(snapshot.personalModels.getExact("custom-provider", "custom-model")?.toJSON()).toEqual({
      properties: { contextWindow: 128_000 },
    });
    expect(JSON.parse(await readFile(personalFilePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "custom-provider",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "secret-key" },
                personalModelIds: ["custom-model"],
                modelOrder: ["custom-model"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "custom-provider",
              modelId: "custom-model",
              config: { properties: { contextWindow: 128_000 } },
            },
          ],
          manualProviderModelRules: [],
        },
      },
    });

    runtime.dispose();
  });

  it("仅使用随包配置，启动与本地重读不访问远端 Release", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-local-"));
    const bundledFilePath = join(root, "bundled.json");
    await writeFile(bundledFilePath, JSON.stringify(emptyBuiltinRelease()), "utf8");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("禁止原厂请求"));
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath: bundledFilePath,
      personalFilePath: join(root, "personal.json"),
      watch: false,
    });
    try {
      await runtime.start();
      expect(runtime.zcodeBuiltinFilePath).toBe(bundledFilePath);
      await runtime.configService.read();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
