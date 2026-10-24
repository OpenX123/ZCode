import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NodeZCodeBuiltinProviderConfigSource,
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("本地随包 Built-in Release", () => {
  it("严格解析两层 Release，并拒绝缺字段和旧单层形状", () => {
    const release = decodeZCodeBuiltinRelease(releaseObject(2, "model-b"));

    expect(release.revision).toBe(2);
    expect(release.config.providers.get("builtin")?.builtinModelIds).toEqual(["model-b"]);
    expect(encodeZCodeBuiltinRelease(release)).toEqual(releaseObject(2, "model-b"));
    expect(() =>
      decodeZCodeBuiltinRelease({ schemaVersion: 1, providers: {}, models: [] }),
    ).toThrow();
    expect(() =>
      decodeZCodeBuiltinRelease({
        schemaVersion: 1,
        revision: 1,
        config: { providers: {} },
      }),
    ).toThrow();
  });

  it("随包 Release 拒绝已退出产品的 ZAPI", () => {
    const release = releaseObject(2, "model-b");

    expect(() =>
      decodeZCodeBuiltinRelease({
        ...release,
        config: {
          ...release.config,
          providerConfigRules: {
            ...release.config.providerConfigRules,
            providerRules: [
              ...release.config.providerConfigRules.providerRules,
              {
                providerId: "builtin:zapi",
                config: {
                  group: "zai-family",
                  access: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "start-plan",
                  },
                  builtinModelIds: ["retired-model"],
                },
              },
            ],
          },
        },
      }),
    ).toThrow("builtin:zapi");
  });

  it("只读随包文件，不选择较新的旧缓存，也不创建锁或重写文件", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "active.json");
    const bundledText = JSON.stringify(releaseObject(1, "bundled-model"));
    const activeText = JSON.stringify(releaseObject(99, "downloaded-model"));
    await writeFile(bundledFilePath, bundledText);
    await writeFile(activeFilePath, activeText);
    const legacySourceOptions = { bundledFilePath, activeFilePath, watch: false };
    const source = new NodeZCodeBuiltinProviderConfigSource(legacySourceOptions);
    try {
      expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
        "bundled-model",
      ]);
      expect(await readFile(bundledFilePath, "utf8")).toBe(bundledText);
      expect(await readFile(activeFilePath, "utf8")).toBe(activeText);
      expect((await readdir(root)).toSorted()).toEqual(["active.json", "bundled.json"]);
      await writeFile(bundledFilePath, "invalid bundled json");
      await expect(source.read()).rejects.toThrow();
      expect(await readFile(activeFilePath, "utf8")).toBe(activeText);
    } finally {
      source.dispose();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-builtin-release-"));
  roots.push(root);
  return root;
}

function releaseObject(revision: number, modelId: string) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "builtin",
            config: {
              group: "zai-family",
              access: {
                type: "zhipu-account",
                accountType: "zai",
                mode: "start-plan",
              },
              builtinModelIds: [modelId],
            },
          },
        ],
        templateRules: [],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}
