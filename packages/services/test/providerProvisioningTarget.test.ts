import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function createEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    syncId: "sync-1",
    personalConfig: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "custom",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "new-key" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              personalModelIds: ["model-a"],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      providerOrder: ["custom"],
      defaultModelSelection: { providerId: "custom", modelId: "model-a" },
    },
    accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
    credentials: [],
    ...overrides,
  };
}

async function createTarget(overrides: { refresh?: () => Promise<unknown> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "provider-provisioning-target-"));
  const personalConfigFilePath = join(directory, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({
    filePath: personalConfigFilePath,
    pollingIntervalMs: false,
  });
  cleanups.push(async () => {
    personal.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await personal.update(() => ({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
    defaultModelSelection: { providerId: "old", modelId: "old-model" },
  }));
  const replacePersonalConfig = vi.spyOn(personal, "update");
  const refresh = vi.fn(async () => {
    await overrides.refresh?.();
    return { sourceRevisions: { config: "target-revision" } };
  });
  const target = createProviderProvisioningTarget({
    providerRuntime: { start: vi.fn(async () => undefined), registryService: { refresh } } as never,
    personalRepository: personal,
    personalConfigFilePath,
    stateFilePath: join(directory, "provisioning.json"),
  });
  return { target, personal, replacePersonalConfig, refresh, personalConfigFilePath, directory };
}

describe("Provider Provisioning Target", () => {
  it.each(["write", "commit"])("%s 阶段失败保留安全错误码且回滚原数据", async (phase) => {
    const f = await createTarget();
    const before = await f.personal.read();
    if (phase === "write")
      f.replacePersonalConfig.mockRejectedValueOnce(new Error("fixture write failed"));
    else await mkdir(join(f.directory, "provisioning.json"));
    expect(await f.target.apply(createEnvelope() as never)).toMatchObject({
      status: "failed",
      errorCode: phase === "write" ? "target-write-failed" : "target-commit-failed",
      rolledBack: true,
    });
    expect((await f.personal.read()).revision).toBe(before.revision);
  });

  it.each([0, 3, 99])("未知 schemaVersion=%s 在任何写入前失败", async (schemaVersion) => {
    const f = await createTarget();
    await expect(f.target.apply(createEnvelope({ schemaVersion }))).rejects.toThrow();
    expect(f.replacePersonalConfig).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("完整替换 Personal、刷新 Registry，重复 syncId 幂等", async () => {
    const { target, personal, replacePersonalConfig, refresh } = await createTarget();

    await expect(target.apply(createEnvelope())).resolves.toMatchObject({
      status: "applied",
      syncId: "sync-1",
      personalProviderCount: 1,
      credentialCount: 0,
      configRevision: "target-revision",
      rolledBack: false,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(replacePersonalConfig).toHaveBeenCalledOnce();
    expect((await personal.read()).defaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });

    await expect(target.apply(createEnvelope())).resolves.toMatchObject({
      status: "already-applied",
      syncId: "sync-1",
    });
    expect(replacePersonalConfig).toHaveBeenCalledOnce();
  });

  it("keeps an idempotency history so an older retry cannot reapply stale data", async () => {
    const { target, replacePersonalConfig } = await createTarget();

    await expect(target.apply(createEnvelope({ syncId: "sync-a" }))).resolves.toMatchObject({
      status: "applied",
    });
    await expect(target.apply(createEnvelope({ syncId: "sync-b" }))).resolves.toMatchObject({
      status: "applied",
    });
    await expect(target.apply(createEnvelope({ syncId: "sync-a" }))).resolves.toMatchObject({
      status: "already-applied",
      syncId: "sync-a",
    });
    expect(replacePersonalConfig).toHaveBeenCalledTimes(2);
  });

  it("applies an empty Personal snapshot so local deletion clears the remote mirror", async () => {
    const { target, replacePersonalConfig } = await createTarget();
    await expect(
      target.apply(
        createEnvelope({
          syncId: "sync-empty-overlay",
          personalConfig: {
            providerConfigRules: { providerRules: [] },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            providerOrder: [],
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "applied", personalProviderCount: 0 });
    expect(replacePersonalConfig).toHaveBeenCalledOnce();
    expect(
      (await replacePersonalConfig.mock.results[0]!.value).defaultModelSelection,
    ).toBeUndefined();
  });

  it("Registry 刷新失败时整份回滚 Personal 与默认选择", async () => {
    const { target, replacePersonalConfig, personal } = await createTarget({
      refresh: vi
        .fn()
        .mockRejectedValueOnce(new Error("registry refresh failed"))
        .mockResolvedValue(undefined),
    });

    await expect(target.apply(createEnvelope({ syncId: "sync-rollback" }))).resolves.toMatchObject({
      status: "failed",
      rolledBack: true,
    });
    expect((await personal.read()).defaultModelSelection).toEqual({
      providerId: "old",
      modelId: "old-model",
    });
    expect(replacePersonalConfig).toHaveBeenCalledTimes(2);
  });
});
