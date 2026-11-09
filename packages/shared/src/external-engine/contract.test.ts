import { describe, expect, it } from "vitest";
import { describeSessionEngine } from "./contract.example.js";
import { engineConfigOptionKind } from "./config-options.js";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  externalEngineStatusSchema,
  externalEngineCheckSchema,
  isExternalSessionEngine,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
  ZCODE_AGENT_ENGINE_NOT_READY_CODE,
  ZCODE_AGENT_ENGINE_NOT_READY_REASON,
} from "./contract.js";

describe("原生配置类别", () => {
  it("模型与思考深度按 configId 判定，权限模式等其余配置为 other", () => {
    expect(engineConfigOptionKind("model")).toBe("model");
    for (const id of ["effort", "reasoning_effort", "reasoning-effort", "thought_level", "Effort"])
      expect(engineConfigOptionKind(id)).toBe("effort");
    for (const id of ["mode", "permission-mode", "fast", "Model"])
      expect(engineConfigOptionKind(id)).toBe("other");
  });
});

describe("外部引擎运行时描述", () => {
  it("检查兼容旧状态，但认证和路由检查必须标明配置身份", () => {
    const check = {
      id: "authentication",
      state: "unknown",
      source: "credentialStore",
      actions: ["test"],
    };
    expect(externalEngineCheckSchema.safeParse(check).success).toBe(false);
    expect(externalEngineCheckSchema.safeParse({ ...check, id: "route" }).success).toBe(false);
    expect(
      externalEngineCheckSchema.parse({
        ...check,
        connectionProfileId: "gateway-a",
        apiKey: "not-in-contract",
      }),
    ).toEqual({ ...check, connectionProfileId: "gateway-a" });
    const oldStatus = {
      engine: "codex",
      adapter: { installed: true },
      officialCli: { found: true },
      auth: { state: "unknown" },
      ready: true,
    };
    expect(externalEngineStatusSchema.parse(oldStatus)).toEqual(oldStatus);
  });
  it("只为外部引擎提供描述，版本锁定为精确版本", () => {
    expect(Object.keys(EXTERNAL_ENGINE_RUNTIMES).sort()).toEqual(["claude-code", "codex"]);
    for (const runtime of Object.values(EXTERNAL_ENGINE_RUNTIMES)) {
      expect(runtime.adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(EXTERNAL_ENGINE_RUNTIMES["claude-code"].officialExecutableEnvVar).toBe(
      "CLAUDE_CODE_EXECUTABLE",
    );
    expect(EXTERNAL_ENGINE_RUNTIMES.codex.officialExecutableEnvVar).toBe("CODEX_PATH");
  });

  it("Claude 子进程需清除会改变计费来源的 Anthropic 变量", () => {
    expect(EXTERNAL_ENGINE_RUNTIMES["claude-code"].strippedEnvVars).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]),
    );
    expect(EXTERNAL_ENGINE_RUNTIMES.codex.strippedEnvVars).toEqual([]);
  });

  it("isExternalSessionEngine 区分 zcode 与外部引擎", () => {
    expect(isExternalSessionEngine("zcode")).toBe(false);
    expect(isExternalSessionEngine("claude-code")).toBe(true);
    expect(isExternalSessionEngine(undefined)).toBe(false);
  });

  it("就绪错误码与 provider_not_ready 并列且不同", () => {
    expect(ZCODE_AGENT_ENGINE_NOT_READY_REASON).toBe("engine_not_ready");
    expect(ZCODE_AGENT_ENGINE_NOT_READY_CODE).toBe("ZCODE_AGENT_ENGINE_NOT_READY");
  });

  it("引擎状态区分未安装、未登录与就绪", () => {
    const status = externalEngineStatusSchema.parse({
      engine: "claude-code",
      adapter: { installed: true, version: "0.95.0", source: "managed" },
      officialCli: { found: true, version: "2.1.310", path: "/usr/local/bin/claude" },
      auth: { state: "loggedIn", label: "Claude subscription" },
      ready: true,
    });
    expect(status.ready).toBe(true);
    expect(
      externalEngineStatusSchema.safeParse({ ...status, auth: { state: "maybe" } }).success,
    ).toBe(false);
  });

  it("示例：zcode 会话无运行时描述，外部引擎取对应描述", () => {
    expect(describeSessionEngine({})).toBeNull();
    expect(describeSessionEngine({ engine: "codex" })?.adapterPackage).toBe(
      "@agentclientprotocol/codex-acp",
    );
  });

  it("安装布局按引擎与锁定版本隔离，入口位于 npm --prefix 产物内", () => {
    const runtime = EXTERNAL_ENGINE_RUNTIMES["claude-code"];
    expect(managedAdapterInstallDirName(runtime)).toBe("claude-code@0.95.0");
    expect(managedAdapterEntrySegments(runtime)).toEqual([
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "dist",
      "index.js",
    ]);
  });
});
