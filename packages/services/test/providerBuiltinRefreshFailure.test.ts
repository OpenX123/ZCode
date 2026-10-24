import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderConfigRuntime } from "#src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "#src/model-provider/providerRuntime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(active: boolean) {
  const root = await mkdtemp(join(tmpdir(), "builtin-local-refresh-"));
  const bundled = join(root, "bundled.json");
  const activePath = join(root, "active.json");
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  release.revision = 1;
  await writeFile(bundled, JSON.stringify(release));
  const legacyActive = "invalid legacy download cache";
  if (active) await writeFile(activePath, legacyActive);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("不得访问网络"));
  const configRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: bundled,
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  const runtime = createProviderRuntimeFromConfigRuntime({ configRuntime });
  cleanups.push(async () => {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.start();
  return { runtime, configRuntime, bundled, activePath, legacyActive, network };
}

describe("独立 Harness 的本地 Built-in 刷新边界", () => {
  it.each([false, true])(
    "旧下载缓存存在=%s：仅读取随包目录，不解析官方端点或覆盖缓存",
    async (active) => {
      const fixture = await setup(active);
      await fixture.runtime.providerSettings.refresh("settings-manual");
      expect((await fixture.runtime.modelSelection.getView()).providers).toEqual([]);
      expect(fixture.runtime.registryService.getSnapshot()!.config.zcodeBuiltinRevision).toMatch(
        "zcode-builtin:1:",
      );
      expect(fixture.network).not.toHaveBeenCalled();
      if (active) expect(await readFile(fixture.activePath, "utf8")).toBe(fixture.legacyActive);
      else await expect(readFile(fixture.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("随包目录损坏时拒绝刷新，不能用旧官方下载缓存伪装成功", async () => {
    const fixture = await setup(true);
    const previous = fixture.runtime.registryService.getSnapshot();
    await writeFile(fixture.bundled, "invalid json");
    await expect(fixture.runtime.providerSettings.refresh("settings-manual")).rejects.toThrow();
    expect(fixture.runtime.registryService.getSnapshot()).toBe(previous);
    expect(fixture.network).not.toHaveBeenCalled();
    expect(await readFile(fixture.activePath, "utf8")).toBe(fixture.legacyActive);
  });
});
