import { expect, it } from "vitest";
import type { MessageWithParts } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// 外部引擎失败轮的 assistant.error 形状与 core/external-engine/turn.ts persistedExternalTurnError 一致。
function messages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "m-user" as never,
        sessionID: "s1" as never,
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: { providerID: "p" as never, modelID: "m" as never },
        anchor: { turnId: "turn-1" as never, origin: "realUser" },
      },
      parts: [
        {
          id: "m-user-text" as never,
          sessionID: "s1" as never,
          messageID: "m-user" as never,
          type: "text",
          text: "检查网关",
        },
      ],
    },
    {
      info: {
        id: "m-assistant" as never,
        sessionID: "s1" as never,
        role: "assistant",
        time: { created: 1100, completed: 1200 },
        parentID: "m-user" as never,
        modelID: "m" as never,
        providerID: "p" as never,
        mode: "default",
        agent: "default",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        anchor: { turnId: "turn-1" as never },
        error: {
          name: "ExternalEngineConnectionError",
          data: {
            message: "unexpected status 502 Bad Gateway: Bad gateway",
            code: "external_engine.provider",
            failure: {
              code: "provider",
              method: "session/prompt",
              httpStatus: 502,
              message: "unexpected status 502 Bad Gateway: Bad gateway",
              url: "https://gateway.example.test/v1/responses",
              requestId: "fixture-request",
              failureId: "codex-turn-1:error",
              retryable: true,
            },
            attribution: { source: "provider", statusCode: 502, retryable: true },
            retryable: true,
          },
        },
      } as never,
      parts: [],
    },
  ];
}

it("冷恢复从 assistant.error.data.failure 还原失败轮的行内错误行", () => {
  const cold = new ProductProjection("s1", "cold");
  for (const event of synthesizeEventsFromMessages(messages(), { sessionId: "s1" }))
    cold.applyEvent(event);
  const snapshot = cold.getSnapshot();
  const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
  expect(header).toMatchObject({
    state: "failed",
    failure: {
      code: "external_engine.provider",
      source: "provider",
      httpStatus: 502,
      url: "https://gateway.example.test/v1/responses",
      requestId: "fixture-request",
      failureId: "codex-turn-1:error",
    },
  });
  expect(snapshot.control.lastError).toMatchObject({ turnId: header?.turnId });
});
