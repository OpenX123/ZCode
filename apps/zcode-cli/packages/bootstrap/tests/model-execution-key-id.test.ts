import { describe, expect, it } from "vitest";
import { zcodeSessionSendParamsSchema } from "@zcode/shared";
import { createModelExecutionContext } from "../src/zcode-protocol/model-execution.js";

describe("请求期 Key ID 执行上下文", () => {
  it("协议与冻结投影保留真实 ID，不将其加入模型 Header", async () => {
    const requestAuth = { apiKey: "user-key", apiKeyId: "real-key-id" };
    const execution = createModelExecutionContext(
      zcodeSessionSendParamsSchema.shape.modelExecution
        .unwrap()
        .parse({ selectionScope: "execution", requestAuth }),
    );
    const value = await execution.requestDependencies?.requestAuth?.source?.resolve({
      attempt: 1,
      providerId: "personal:provider",
      modelId: "glm",
    });
    expect(value).toEqual(requestAuth);
    expect(Object.isFrozen(value)).toBe(true);
  });
  it("实时执行协议拒绝旧商业回退声明", () => {
    expect(() =>
      zcodeSessionSendParamsSchema.shape.modelExecution.unwrap().parse({
        selectionScope: "execution",
        selectionFallback: { providerId: "account:retired", rules: [] },
      }),
    ).toThrow();
  });
});
