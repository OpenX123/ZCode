import { describe, expect, it } from "vitest";
import * as protocol from "../src/zcode-protocol/index.js";

it("备用许可严格拒绝自报 workspace、环境摘要及空 requestId", () => {
  const schema = protocol.zcodeExternalEngineSpareRequestParamsSchema;
  expect(schema).toBeDefined();
  expect(schema.safeParse({ requestId: "request-1" }).success).toBe(true);
  for (const params of [
    { requestId: "" },
    { requestId: " " },
    { requestId: "r", workspacePath: "/other" },
    { requestId: "r", generation: "secret" },
  ])
    expect(schema.safeParse(params).success).toBe(false);
  expect(
    protocol.zcodeExternalEngineAcquireSpareResultSchema.safeParse({ leaseId: "" }).success,
  ).toBe(false);
  expect(
    protocol.zcodeExternalEnginePrepareSpareParamsSchema.safeParse({
      engine: "zcode",
      connectionProfileId: "inherit",
    }).success,
  ).toBe(false);
});
it("W4：acquire 可选带外部引擎（严格枚举），窗口许可上限为 2", () => {
  const schema = protocol.zcodeExternalEngineSpareRequestParamsSchema;
  expect(schema.safeParse({ requestId: "r", engine: "claude-code" }).success).toBe(true);
  expect(schema.safeParse({ requestId: "r", engine: "codex" }).success).toBe(true);
  expect(schema.safeParse({ requestId: "r", engine: "zcode" }).success).toBe(false);
  expect(protocol.EXTERNAL_ENGINE_SPARE_PERMITS_PER_WINDOW).toBe(2);
});
import {
  MAX_VISIBLE_SESSIONS_PER_REPORT,
  V4_METHODS,
  conversationVisibilityParamsSchema,
  v4ConversationVisibilityParamsSchema,
  v4ConversationVisibilityResultSchema,
} from "../src/zcode-protocol-v4/index.js";

// 规则见 docs/desktop/external-agent-engines-spec.md「可见性输入」：Renderer 拥有可见事实，
// 按连接整体替换上报；CLI 只用作外部引擎闲置关闭的豁免依据。
describe("ZCode Protocol V4 会话可见性上报", () => {
  it("方法名固定，参数为连接 ID + 可见会话 ID 列表，结果为空对象", () => {
    expect(V4_METHODS.conversationVisibility).toBe("v4/conversation/visibility");
    expect(
      v4ConversationVisibilityParamsSchema.parse({
        connectionId: "connection-1",
        visibleSessionIds: ["session_a", "session_b"],
      }),
    ).toEqual({ connectionId: "connection-1", visibleSessionIds: ["session_a", "session_b"] });
    // 空集合 = 该连接当前没有可见会话（例如窗口最小化），合法。
    expect(
      v4ConversationVisibilityParamsSchema.safeParse({
        connectionId: "connection-1",
        visibleSessionIds: [],
      }).success,
    ).toBe(true);
    expect(v4ConversationVisibilityResultSchema.parse({})).toEqual({});
    expect(v4ConversationVisibilityResultSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("UI-facing 形状不能自选 connectionId（由 Host 按下游客户端注入）", () => {
    expect(conversationVisibilityParamsSchema.parse({ visibleSessionIds: ["session_a"] })).toEqual({
      visibleSessionIds: ["session_a"],
    });
    expect(
      conversationVisibilityParamsSchema.safeParse({
        connectionId: "forged",
        visibleSessionIds: ["session_a"],
      }).success,
    ).toBe(false);
  });

  it("拒绝未知字段、缺失连接 ID、空会话 ID 与超出上限的列表", () => {
    const invalid: unknown[] = [
      { connectionId: "connection-1", visibleSessionIds: ["session_a"], visible: true },
      { visibleSessionIds: ["session_a"] },
      { connectionId: "", visibleSessionIds: [] },
      { connectionId: "connection-1", visibleSessionIds: [""] },
      { connectionId: "connection-1", visibleSessionIds: ["  "] },
      { connectionId: "connection-1", visibleSessionIds: "session_a" },
      {
        connectionId: "connection-1",
        visibleSessionIds: Array.from(
          { length: MAX_VISIBLE_SESSIONS_PER_REPORT + 1 },
          (_, index) => `session_${index}`,
        ),
      },
    ];
    for (const params of invalid) {
      expect(v4ConversationVisibilityParamsSchema.safeParse(params).success).toBe(false);
    }
    expect(
      v4ConversationVisibilityParamsSchema.safeParse({
        connectionId: "connection-1",
        visibleSessionIds: Array.from(
          { length: MAX_VISIBLE_SESSIONS_PER_REPORT },
          (_, index) => `session_${index}`,
        ),
      }).success,
    ).toBe(true);
  });
});
