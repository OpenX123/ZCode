import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigRules, parsePersonalProviderConfigMap } from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderProvisioningSource } from "../src/model-provider/providerProvisioningSource.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-provider-provisioning-source-"));
  const filePath = join(root, "provider_config.json");
  const repository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
  });
  cleanups.push(async () => {
    repository.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const source = createProviderProvisioningSource({
    personalRepository: repository,
    personalConfigFilePath: filePath,
  });
  return { root, filePath, repository, source };
}

describe("Provider Provisioning Source", () => {
  it("只导出完整 Personal 快照与默认选择，不读取账号或凭据", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "credentials.json"), "{broken");
    await f.repository.update(() => ({
      providers: parsePersonalProviderConfigMap({
        providerRules: [
          {
            providerId: "custom",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "provider-key" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              personalModelIds: ["model-a"],
            },
          },
        ],
      }),
      models: ModelConfigRules.empty(),
      providerOrder: ["custom"],
      defaultModelSelection: { providerId: "custom", modelId: "model-a" },
    }));
    const snapshot = await f.source.read("sync-source");
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.personalConfig).toEqual(
      encodeProviderConfigFile(await f.repository.read()).config,
    );
    expect(snapshot.personalConfig.defaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    expect(snapshot.credentials).toEqual([]);
    expect(snapshot.accountSettings).toEqual({
      providerFamilyDomain: null,
      providerFamilyConnectionSelections: {},
    });
    expect(snapshot).not.toHaveProperty("sourceRevision");
  });

  it("首次无 Personal 文件时允许导出空配置，坏文件不能降级为旧内存快照", async () => {
    const f = await fixture();
    expect((await f.source.read("empty")).personalConfig.providerConfigRules.providerRules).toEqual(
      [],
    );
    await f.repository.update(() => ({
      providers: parsePersonalProviderConfigMap({ providerRules: [] }),
      models: ModelConfigRules.empty(),
    }));
    await writeFile(f.filePath, "{broken");
    await expect(f.source.read("corrupt")).rejects.toThrow("无法同步");
  });
});
