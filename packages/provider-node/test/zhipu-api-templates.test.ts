import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseZCodeBuiltinModelConfigRules } from "@zcode/provider";

describe("普通 GLM API 模板", () => {
  it.each(["zcode-builtin.json", "zcode-builtin.test.json"])(
    "%s 只提供用户 API Key 模板与公开端点",
    async (filename) => {
      const release = JSON.parse(
        await readFile(new URL(`../../../config/provider/${filename}`, import.meta.url), "utf8"),
      );
      const templates = release.config.providerConfigRules.templateRules;
      const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
      for (const family of ["zai", "bigmodel"]) {
        const templateId = `${family}-standard-api`;
        const template = templates.find(
          (item: { templateId: string }) => item.templateId === templateId,
        );
        expect(template, templateId).toBeDefined();
        expect(
          templates.some((item: { templateId: string }) => item.templateId === `${family}-api`),
        ).toBe(false);
        expect(template.config.access.type).toBe("api-key");
        expect(new URL(template.config.access.apiKeyManagementUrl).protocol).toBe("https:");
        expect(template.config.api).toEqual({
          type: "openai-chat-completions",
          baseUrl: `https://${family === "zai" ? "api.z.ai" : "open.bigmodel.cn"}/api/paas/v4`,
        });
        for (const modelId of ["GLM-5.3", "GLM-5.3-Flash"]) {
          const resolved = rules.resolve({
            templateId,
            providerId: "personal-fixture",
            modelId,
            apiType: template.config.api.type,
            baseUrl: template.config.api.baseUrl,
          });
          expect(template.config.builtinModelIds).toContain(modelId);
          expect(resolved.enabled).toBe(true);
          expect(resolved.properties?.inputFormat?.supportsImage).toBe(modelId.endsWith("Flash"));
          expect(resolved.properties?.supportsNativeWebSearch).toBe(false);
          expect(resolved.properties?.supportsMidConversationSystem).toBe(false);
        }
      }
    },
  );
});
