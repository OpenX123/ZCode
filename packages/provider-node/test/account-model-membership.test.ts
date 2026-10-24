import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";

it.each(["zcode-builtin.json", "zcode-builtin.test.json"])(
  "%s 不提供官方套餐成员或产品网关规则，保留普通 GLM API 模板",
  async (filename) => {
    const bundledFilePath = fileURLToPath(
      new URL(`../../../config/provider/${filename}`, import.meta.url),
    );
    const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath, watch: false });
    try {
      const snapshot = await source.read();
      expect(snapshot.providers.keys()).toEqual([]);
      const raw = JSON.parse(await readFile(bundledFilePath, "utf8"));
      const config = JSON.stringify(raw.config);
      expect(config).not.toContain("account:");
      expect(config).not.toContain("zcode-plan");
      expect(config).not.toContain("highspeed/anthropic");
      expect(config).toContain("open.bigmodel.cn/api/paas/v4");
      expect(config).toContain("api.z.ai/api/paas/v4");
      expect(config).toContain("GLM-5.3");
    } finally {
      source.dispose();
    }
  },
);
