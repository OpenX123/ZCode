import { describe, expect, it } from "vitest";
import { describeSessionEngine } from "./contract.example.js";
import {
  engineConfigOptionKind,
  engineConfigOptionPlacement,
  engineFastToggle,
  isRememberableEngineConfig,
} from "./config-options.js";
import { externalEngineConnectionTestResultSchema } from "./connection.js";
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

  it("输入区放置：仅 mode 常驻，Fast 类按归一化 id 识别，其余进入更多", () => {
    expect(engineConfigOptionPlacement("mode")).toBe("primary-mode");
    expect(engineConfigOptionPlacement("model")).toBe("model");
    expect(engineConfigOptionPlacement("reasoning_effort")).toBe("effort");
    for (const id of ["fast", "fast-mode", "fast_mode", "Fast", "speed", "service_tier"])
      expect(engineConfigOptionPlacement(id)).toBe("fast");
    for (const id of ["agent", "collaboration_mode", "permission-mode", "Mode"])
      expect(engineConfigOptionPlacement(id)).toBe("more");
  });

  it("Fast 开关只接受 on/off 类两值 select，点亮跟随确认值，形态不符返回 null", () => {
    // 本机 adapter（Claude 0.95.0 id fast、Codex 2.2.2 id fast-mode）在未声明 boolean 能力时的真实形态。
    const codex = {
      id: "fast-mode",
      name: "Fast mode",
      currentValue: "off",
      options: [
        { value: "off", name: "Off" },
        { value: "on", name: "On" },
      ],
    };
    expect(engineFastToggle(codex)).toEqual({ enabled: false, onValue: "on", offValue: "off" });
    expect(engineFastToggle({ ...codex, id: "fast", currentValue: "on" })).toEqual({
      enabled: true,
      onValue: "on",
      offValue: "off",
    });
    expect(
      engineFastToggle({
        ...codex,
        options: [
          { value: "TRUE", name: "Yes" },
          { value: "False", name: "No" },
        ],
        currentValue: "TRUE",
      }),
    ).toEqual({ enabled: true, onValue: "TRUE", offValue: "False" });
    // 非 Fast 类 id、多档 service tier、未知取值都不渲染为闪电。
    expect(engineFastToggle({ ...codex, id: "agent" })).toBeNull();
    expect(
      engineFastToggle({
        ...codex,
        id: "service_tier",
        options: [
          { value: "auto", name: "Auto" },
          { value: "default", name: "Default" },
          { value: "flex", name: "Flex" },
        ],
      }),
    ).toBeNull();
    expect(
      engineFastToggle({
        ...codex,
        options: [
          { value: "native-off", name: "Off" },
          { value: "native-on", name: "On" },
        ],
      }),
    ).toBeNull();
  });
});

describe("可记忆的原生配置", () => {
  it("模型、思考深度与权限模式可记忆；计划类模式与其它配置不记忆", () => {
    expect(isRememberableEngineConfig("model", "gpt-a")).toBe(true);
    expect(isRememberableEngineConfig("reasoning_effort", "high")).toBe(true);
    for (const value of ["auto", "acceptEdits", "bypassPermissions", "default"])
      expect(isRememberableEngineConfig("mode", value)).toBe(true);
    for (const value of ["plan", "Plan"])
      expect(isRememberableEngineConfig("mode", value)).toBe(false);
    for (const id of ["permission-mode", "fast", "Mode", "collaboration_mode"])
      expect(isRememberableEngineConfig(id, "auto")).toBe(false);
  });
});

describe("测试连接结果", () => {
  it("success 可带脱敏警告（1–5 条、每条 1–300 字），旧结果不带也合法", () => {
    const warnings = [{ message: "Model metadata not found" }];
    expect(
      externalEngineConnectionTestResultSchema.parse({
        status: "success",
        latencyMs: 10,
        warnings,
      }),
    ).toEqual({ status: "success", latencyMs: 10, warnings });
    expect(
      externalEngineConnectionTestResultSchema.parse({ status: "success", latencyMs: 10 }),
    ).toEqual({ status: "success", latencyMs: 10 });
    for (const invalid of [
      [],
      [{ message: "" }],
      [{ message: "x".repeat(301) }],
      Array.from({ length: 6 }, (_, index) => ({ message: `w${index}` })),
    ])
      expect(
        externalEngineConnectionTestResultSchema.safeParse({
          status: "success",
          latencyMs: 10,
          warnings: invalid,
        }).success,
      ).toBe(false);
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
