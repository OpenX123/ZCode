import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";
import { importLegacyCliPersonalProviderConfig } from "../src/app/legacy-cli-personal-provider-config-importer.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Todo104 CLI 同文件默认选择", () => {
  it("旧输入一次性产出 Provider 外层身份、模型配置与默认选择", () => {
    const input = {
      model: "custom/model-a",
      provider: {
        custom: {
          name: "My Provider",
          kind: "openai-compatible",
          options: { apiKey: "fixture-key", baseURL: "https://fixture.test/v1" },
          models: { "model-a": { limit: { context: 64_000 } } },
        },
      },
    };
    const before = JSON.stringify(input);
    const imported = importLegacyCliPersonalProviderConfig({ input });
    expect(imported.defaultModelSelection).toEqual({ providerId: "custom", modelId: "model-a" });
    expect(imported.providers.getRule("custom")?.providerName).toBe("My Provider");
    expect(imported.models.toPersonalJSON().providerModelRules[0]?.modelId).toBe("model-a");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("Standalone 首次导入、Protocol 重启及清空默认只使用同一 Personal 文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo104-cli-personal-"));
    directories.push(directory);
    const personalPath = join(directory, "provider_config.json");
    const legacyPath = join(directory, "legacy.json");
    const oldInput = JSON.stringify({ model: "fixture/model-a" });
    await writeFile(legacyPath, oldInput);
    const env = {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
    };
    const standalone = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyPath },
    });
    try {
      expect(standalone.configuredDefaultModelSelection).toEqual({
        providerId: "fixture",
        modelId: "model-a",
      });
      expect(JSON.parse(await readFile(personalPath, "utf8")).config.defaultModelSelection).toEqual(
        standalone.configuredDefaultModelSelection,
      );
    } finally {
      standalone.dispose();
    }
    const protocol = await startProcessProviderRegistryRuntime(env);
    try {
      expect(protocol.configuredDefaultModelSelection).toEqual({
        providerId: "fixture",
        modelId: "model-a",
      });
      await protocol.modelSelectionConfigRepository!.saveConfiguredDefault(undefined);
      expect(
        (await protocol.runtime.personalRepository.read()).defaultModelSelection,
      ).toBeUndefined();
    } finally {
      protocol.dispose();
    }
    const restart = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyPath },
    });
    try {
      expect(restart.configuredDefaultModelSelection).toBeUndefined();
      expect(await readFile(legacyPath, "utf8")).toBe(oldInput);
      await expect(readFile(join(directory, "model-selection.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restart.dispose();
    }
  });
});
