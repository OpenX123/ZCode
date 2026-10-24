import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { NodeProviderRegistryRuntime } from "../src/index.js";
import { createNodeModelSelectionFacade } from "../src/model-selection-facade.js";

it("Host/Worker 只使用本地 API Provider，旧套餐选择失效且不映射到同名 GLM", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-selection-"));
  const personalFilePath = join(root, "personal.json");
  const personal = {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "personal-glm",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "test-only" },
            api: { type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
            personalModelIds: ["GLM-5.2"],
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        { providerId: "personal-glm", modelId: "GLM-5.2", config: { enabled: true } },
      ],
      manualProviderModelRules: [],
    },
  };
  await writeFile(personalFilePath, JSON.stringify({ schemaVersion: 1, config: personal }));
  const runtime = new NodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath,
    personalPollingIntervalMs: false,
  });
  try {
    await runtime.start();
    const facade = createNodeModelSelectionFacade(runtime.registryService);
    const current = facade
      .getView()
      .providers.find((provider) => provider.providerId === "personal-glm")!;
    const selection = Object.freeze({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: current.models[0]!.config.optionSpecs.reasoningLevel.values[0]! },
    });
    expect(facade.getView(undefined, undefined, { selection })).toMatchObject({
      effectiveSelection: null,
      selectionIssue: "provider-not-found",
    });
    expect(facade.getView().providers.map((provider) => provider.providerId)).toEqual([
      "personal-glm",
    ]);
    expect(selection.providerId).toBe("account:bigmodel-individual-coding-plan");
    expect(JSON.parse(await readFile(personalFilePath, "utf8"))).toEqual({
      schemaVersion: 1,
      config: personal,
    });
    expect(runtime.registryService.getSnapshot()).not.toHaveProperty("account");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
