import { zcodeSessionInfoSchema } from "../src/zcode-protocol-legacy-types.js";
import {
  zcodeSessionCreateParamsSchema,
  zcodeSessionListParamsSchema,
} from "../src/zcode-protocol/index.js";
import { describe, expect, it } from "vitest";
import {
  commandPayloadSchemas,
  COMMANDS_REQUIRING_BASE_REVISION,
  sessionConfigStateSchema,
} from "../src/zcode-protocol-v4/index.js";
import { createSessionRequestedConfigSchema } from "../src/zcode-protocol-v4/create-session-config.js";
import {
  DEFAULT_SESSION_ENGINE,
  resolveSessionEngine,
  sessionEngineSchema,
} from "../src/external-engine/index.js";

const baseConfig = { provider: "p", model: "m", thought: "t", followupMode: "queue" as const };

describe("会话引擎协议", () => {
  it("Host 创建、身份查询与草稿读取共用引擎值域", () => {
    const workspace = { workspacePath: "/workspace", workspaceKey: "/workspace" };
    expect(zcodeSessionCreateParamsSchema.parse({ workspace, engine: "codex" }).engine).toBe(
      "codex",
    );
    expect(
      zcodeSessionListParamsSchema.parse({ sessionIds: ["s1"], includeDrafts: true }).includeDrafts,
    ).toBe(true);
    expect(
      zcodeSessionInfoSchema.parse({
        sessionId: "s1",
        workspace,
        engine: "claude-code",
        sessionKind: "interactive",
        title: "test",
        mode: "build",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      }).engine,
    ).toBe("claude-code");
  });
  it("引擎值域固定为 zcode / claude-code / codex，缺省为 zcode", () => {
    expect(sessionEngineSchema.options).toEqual(["zcode", "claude-code", "codex"]);
    expect(DEFAULT_SESSION_ENGINE).toBe("zcode");
    expect(sessionEngineSchema.safeParse("opencode").success).toBe(false);
  });

  it("createSession 可请求引擎；不传时保持未指定，不被默认值改写", () => {
    expect(createSessionRequestedConfigSchema.parse({ engine: "claude-code" }).engine).toBe(
      "claude-code",
    );
    expect(createSessionRequestedConfigSchema.parse({}).engine).toBeUndefined();
    expect(createSessionRequestedConfigSchema.safeParse({ engine: "gemini" }).success).toBe(false);
  });

  it("旧快照缺 engine 时保持原样，读取时视为 zcode", () => {
    const parsed = sessionConfigStateSchema.parse(baseConfig);
    expect(parsed.engine).toBeUndefined();
    expect(resolveSessionEngine(parsed)).toBe("zcode");
    expect(parsed.engineConfigOptions).toBeUndefined();
  });

  it("快照携带引擎配置项（模式、模型、effort 统一为 configOptions）", () => {
    const parsed = sessionConfigStateSchema.parse({
      ...baseConfig,
      engine: "codex",
      engineConfigOptions: [
        {
          id: "mode",
          name: "Mode",
          currentValue: "agent",
          options: [
            { value: "read-only", name: "Read-only" },
            { value: "agent", name: "Auto review" },
          ],
        },
      ],
    });
    expect(parsed.engineConfigOptions?.[0]?.currentValue).toBe("agent");
  });

  it("setEngineConfigOption 需要 configId 与 value，并走 CAS", () => {
    expect(
      commandPayloadSchemas.setEngineConfigOption.parse({ configId: "model", value: "opus" }),
    ).toEqual({
      configId: "model",
      value: "opus",
    });
    expect(
      commandPayloadSchemas.setEngineConfigOption.safeParse({ configId: "", value: "x" }).success,
    ).toBe(false);
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("setEngineConfigOption")).toBe(true);
  });
});

it("连接错误快照仅携带安全分类与方法，旧快照兼容且非法分类拒绝", () => {
  const config = sessionConfigStateSchema.parse({
    ...baseConfig,
    engineConfigState: "error",
    engineConfigError: {
      code: "authentication",
      method: "session/resume",
      rpcCode: -32000,
      private: "must-drop",
    },
  });
  expect(config.engineConfigError).toEqual({
    code: "authentication",
    method: "session/resume",
    rpcCode: -32000,
  });
  expect(
    sessionConfigStateSchema.safeParse({ ...baseConfig, engineConfigError: { code: "raw-error" } })
      .success,
  ).toBe(false);
  expect(sessionConfigStateSchema.parse(baseConfig).engineConfigError).toBeUndefined();
});
