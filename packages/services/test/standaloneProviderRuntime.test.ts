import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderProvisioningSource } from "../src/model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { createZCodeSessionService } from "../src/zcode-session/zcodeSessionService.js";
import type { IZCodeAgentService } from "@zcode/services";
import {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
} from "../src/model-provider/providerRuntime.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("独立 Harness Provider", () => {
  it("H02 本地目录无需账号即可创建普通 GLM Provider，重启后仍可执行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "standalone-provider-"));
    directories.push(directory);
    const options = {
      zcodeBuiltinFilePath: resolve("config/provider/zcode-builtin.json"),
      personalFilePath: join(directory, "personal.json"),
      personalPollingIntervalMs: false as const,
      watch: false,
    };
    let runtime = createProviderRuntime(options);
    try {
      const initial = await runtime.modelSelection.getView();
      expect(initial.providers).toHaveLength(0);
      const created = await runtime.providerSettings.createPersonalProvider({
        templateId: "bigmodel-standard-api",
      });
      const provider = created.view.providers.find(
        (item) => item.providerId === created.providerId,
      )!;
      await runtime.providerSettings.savePersonalProviderOverlay(created.providerId, {
        access: { type: "api-key", apiKey: "isolated-test-key" },
      });
      const view = await runtime.modelSelection.getView();
      expect(
        view.providers
          .find((item) => item.providerId === created.providerId)
          ?.models.some((model) => !model.disabledReason),
      ).toBe(true);
      expect(provider.effectiveConfig.access?.type).toBe("api-key");
      runtime.dispose();
      runtime = createProviderRuntime(options);
      expect(
        (await runtime.modelSelection.getView()).providers.some(
          (item) => item.providerId === created.providerId,
        ),
      ).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
  it("H04 旧套餐选择失效也不映射到普通 API，不修改原选择", async () => {
    const directory = await mkdtemp(join(tmpdir(), "standalone-history-"));
    directories.push(directory);
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath: resolve("config/provider/zcode-builtin.json"),
      personalFilePath: join(directory, "personal.json"),
      watch: false,
      personalPollingIntervalMs: false,
    });
    try {
      const old = {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
      };
      const result = await runtime.modelSelection.getView({ selection: old });
      expect(result.effectiveSelection).toBeNull();
      expect(result.selectionIssue).toBe("provider-not-found");
      expect(old.providerId).toBe("account:bigmodel-individual-coding-plan");
    } finally {
      runtime.dispose();
    }
  });

  it("H06 SSH 分发只复制 Personal，保留目标旧凭据且重复信封幂等", async () => {
    const directory = await mkdtemp(join(tmpdir(), "standalone-provision-"));
    directories.push(directory);
    const personalPath = join(directory, "personal.json");
    const configRuntime = createProviderConfigRuntime({
      zcodeBuiltinFilePath: resolve("config/provider/zcode-builtin.json"),
      personalFilePath: personalPath,
      watch: false,
      personalPollingIntervalMs: false,
    });
    const runtime = createProviderRuntimeFromConfigRuntime({ configRuntime });
    const credentialPath = join(directory, "credentials.json");
    await writeFile(credentialPath, '{"oauth:active_provider":"unreadable-legacy-ciphertext"}');
    try {
      await runtime.start();
      const source = createProviderProvisioningSource({
        personalRepository: configRuntime.personalRepository,
        personalConfigFilePath: personalPath,
      });
      const envelope = await source.read("local-only");
      expect(envelope.credentials).toEqual([]);
      const before = await readFile(credentialPath, "utf8");
      const target = createProviderProvisioningTarget({
        providerRuntime: runtime,
        personalRepository: configRuntime.personalRepository,
        personalConfigFilePath: personalPath,
        stateFilePath: join(directory, "provisioning.json"),
      });
      expect((await target.apply(envelope)).status).toBe("applied");
      expect((await target.apply(envelope)).status).toBe("already-applied");
      expect(await readFile(credentialPath, "utf8")).toBe(before);
    } finally {
      runtime.dispose();
    }
  });

  it("H04 旧分享导入正文继续从本地副本读取", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "standalone-import-"));
    directories.push(workspace);
    await mkdir(join(workspace, ".zcode-share", "legacy-share"), { recursive: true });
    await writeFile(
      join(workspace, ".zcode-share", "legacy-share", "shared-conversation.json"),
      JSON.stringify({
        formatVersion: 1,
        shareId: "share",
        contextId: "context",
        title: "旧导入",
        rows: [],
        artifacts: [
          {
            artifactId: "artifact",
            displayName: "example.ts",
            workspaceRelativePath: "example.ts",
          },
        ],
      }),
    );
    const service = createZCodeSessionService({ agentService: {} as IZCodeAgentService });
    expect(
      await service.getImportedConversation({ workspacePath: workspace, contextId: "context" }),
    ).toMatchObject({
      title: "旧导入",
      shareId: "share",
      artifacts: [{ displayName: "example.ts" }],
    });
    expect(
      await service.getImportedConversation({ workspacePath: workspace, contextId: "missing" }),
    ).toBeNull();
  });
});
