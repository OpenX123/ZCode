import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

describe("独立 Harness 本地 Built-in 恢复", () => {
  it("损坏本地目录保留完整旧 Registry，修复后从同一配置 owner 刷新", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-builtin-recovery-"));
    const builtin = join(root, "builtin.json");
    const release = {
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    };
    await writeFile(builtin, JSON.stringify(release));
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath: builtin,
      personalFilePath: join(root, "personal.json"),
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      await runtime.start();
      const old = runtime.registryService.getSnapshot()!;
      await writeFile(builtin, "invalid json");
      await expect(runtime.providerSettings.refresh("settings-manual")).rejects.toThrow();
      expect(runtime.registryService.getSnapshot()).toBe(old);
      await writeFile(builtin, JSON.stringify({ ...release, revision: 2 }));
      await runtime.providerSettings.refresh("settings-manual");
      const next = runtime.registryService.getSnapshot()!;
      expect(next.config.zcodeBuiltinRevision).toMatch("zcode-builtin:2:");
      expect(next).not.toHaveProperty("account");
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
