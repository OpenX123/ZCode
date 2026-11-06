import { describe, expect, it } from "vitest";
import {
  buildEngineConnectionEnv,
  builtInEngineConnectionProfiles,
  engineConnectionGatewayHost,
  engineConnectionUrlHost,
  externalEngineConnectionsSchema,
  findEngineConnectionProfile,
  isOfficialEngineBaseUrl,
  lastUsedEngineConnectionProfileId,
  resolveEngineConnectionProfileId,
  type ExternalEngineConnectionProfile,
} from "../src/external-engine/index.js";

const inherited = {
  PATH: "/bin",
  APP_SERVER_LOGS: "raw-frames.log",
  ANTHROPIC_API_KEY: "inherited-anthropic-key",
  anthropic_auth_token: "inherited-token",
  Anthropic_Base_Url: "https://inherited-gateway.example",
  ANTHROPIC_MODEL: "inherited-model",
  ANTHROPIC_CUSTOM_HEADERS: "X-Gateway: inherited",
  CLAUDE_CODE_USE_BEDROCK: "1",
  OPENAI_API_KEY: "inherited-openai-key",
  OPENAI_BASE_URL: "https://inherited-openai.example/v1",
  CODEX_HOME: "/users/me/.codex",
  HTTPS_PROXY: "http://proxy.example:8080",
};
const profile = (fields: Partial<ExternalEngineConnectionProfile>) =>
  ({
    id: "profile-a",
    engine: "claude-code",
    mode: "inherit",
    hasApiKey: false,
    ...fields,
  }) as ExternalEngineConnectionProfile;

describe("外部引擎连接环境规则", () => {
  it("沿用 CLI 保留原环境（含 ANTHROPIC_* 与代理），只剔除原生帧日志开关", () => {
    for (const engine of ["claude-code", "codex"] as const) {
      const env = buildEngineConnectionEnv({ env: inherited, profile: profile({ engine }) });
      expect(env.APP_SERVER_LOGS).toBeUndefined();
      expect(env).toMatchObject({
        ANTHROPIC_API_KEY: "inherited-anthropic-key",
        Anthropic_Base_Url: "https://inherited-gateway.example",
        OPENAI_BASE_URL: "https://inherited-openai.example/v1",
        CODEX_HOME: "/users/me/.codex",
        HTTPS_PROXY: "http://proxy.example:8080",
      });
    }
  });

  it("Claude 官方登录与旧会话只去除三项计费变量（1.0.7 行为，大小写不敏感）", () => {
    const env = buildEngineConnectionEnv({
      env: inherited,
      profile: profile({ id: "official", mode: "official" }),
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.anthropic_auth_token).toBeUndefined();
    expect(env.Anthropic_Base_Url).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe("inherited-model");
    expect(env.HTTPS_PROXY).toBe("http://proxy.example:8080");
  });

  it("Claude API Key：官方地址只用 ANTHROPIC_API_KEY，自定义网关用 Bearer 与 BASE_URL，其余 Anthropic 覆盖全部去除", () => {
    const official = buildEngineConnectionEnv({
      env: inherited,
      profile: profile({ mode: "apiKey", baseUrl: "https://api.anthropic.com", model: "claude-x" }),
      apiKey: "profile-secret",
    });
    expect(official).toMatchObject({
      ANTHROPIC_API_KEY: "profile-secret",
      ANTHROPIC_MODEL: "claude-x",
    });
    for (const key of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "anthropic_auth_token",
      "Anthropic_Base_Url",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
    ])
      expect(official[key]).toBeUndefined();
    const gateway = buildEngineConnectionEnv({
      env: inherited,
      profile: profile({ mode: "apiKey", baseUrl: "https://gateway.example/anthropic" }),
      apiKey: "profile-secret",
    });
    expect(gateway).toMatchObject({
      ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "profile-secret",
    });
    expect(gateway.ANTHROPIC_API_KEY).toBeUndefined();
    expect(gateway.ANTHROPIC_MODEL).toBeUndefined();
    // Host 诊断不传密钥时也不能残留任何继承的 Anthropic 凭据。
    const diagnostic = buildEngineConnectionEnv({
      env: inherited,
      profile: profile({ mode: "apiKey", baseUrl: "https://gateway.example" }),
    });
    expect(Object.keys(diagnostic).some((key) => /^anthropic_/i.test(key))).toBe(false);
  });

  it("Codex 管理连接使用专用 CODEX_HOME 并去除继承的网关、密钥与 provider 覆盖", () => {
    const env = buildEngineConnectionEnv({
      env: { ...inherited, codex_config: "{}", MODEL_PROVIDER: "gateway" },
      profile: profile({ engine: "codex", mode: "apiKey", model: "model-a" }),
      codexHome: "/ycode/engines/connections/profile-a/codex-home",
    });
    expect(env.CODEX_HOME).toBe("/ycode/engines/connections/profile-a/codex-home");
    expect(env.CODEX_CONFIG).toBe('{"model":"model-a"}');
    for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_PROVIDER", "codex_config"])
      expect(env[key]).toBeUndefined();
    expect(() =>
      buildEngineConnectionEnv({
        env: inherited,
        profile: profile({ engine: "codex", mode: "official" }),
      }),
    ).toThrow("external_engine_connection_invalid");
  });
});

describe("连接配置绑定与缺省", () => {
  const connections = externalEngineConnectionsSchema.parse({
    activeProfileId: "legacy-codex",
    profiles: [
      { id: "inherit", mode: "inherit" },
      {
        id: "legacy-codex",
        mode: "apiKey",
        baseUrl: "https://gateway.example/v1",
        hasApiKey: true,
      },
      { id: "claude-gw", engine: "claude-code", mode: "apiKey", hasApiKey: true },
      { id: "claude-old", engine: "claude-code", mode: "official", hidden: true },
    ],
  });

  it("1.0.7 配置缺省属于 Codex，内置配置不落盘且两家各自独立", () => {
    expect(connections.profiles[1]?.engine).toBe("codex");
    expect(builtInEngineConnectionProfiles("codex").map((item) => item.id)).toEqual(["inherit"]);
    expect(builtInEngineConnectionProfiles("claude-code").map((item) => item.id)).toEqual([
      "official",
      "inherit",
    ]);
    expect(findEngineConnectionProfile(connections, "claude-code", "legacy-codex")).toBeUndefined();
    expect(findEngineConnectionProfile(connections, "claude-code", "inherit")?.engine).toBe(
      "claude-code",
    );
  });

  it("新会话用上次使用值，Codex 兼容旧 activeProfileId，隐藏或缺失时回落内置缺省", () => {
    expect(lastUsedEngineConnectionProfileId(connections, "codex")).toBe("legacy-codex");
    expect(lastUsedEngineConnectionProfileId(connections, "claude-code")).toBe("official");
    expect(
      lastUsedEngineConnectionProfileId(
        { ...connections, lastUsed: { "claude-code": "claude-old", codex: "missing" } },
        "claude-code",
      ),
    ).toBe("official");
    expect(
      lastUsedEngineConnectionProfileId(
        { ...connections, lastUsed: { codex: "missing" } },
        "codex",
      ),
    ).toBe("inherit");
    expect(lastUsedEngineConnectionProfileId(undefined, "codex")).toBe("inherit");
  });

  it("显式绑定优先；无绑定的旧原生会话保持 1.0.7 行为，不随上次使用值切换身份", () => {
    const withLastUsed = { ...connections, lastUsed: { "claude-code": "claude-gw" } };
    expect(
      resolveEngineConnectionProfileId(withLastUsed, {
        engine: "claude-code",
        connectionProfileId: "claude-old",
      }),
    ).toBe("claude-old");
    expect(
      resolveEngineConnectionProfileId(withLastUsed, {
        engine: "claude-code",
        externalSessionId: "native",
      }),
    ).toBe("official");
    expect(
      resolveEngineConnectionProfileId(withLastUsed, {
        engine: "codex",
        externalSessionId: "native",
      }),
    ).toBe("inherit");
    expect(resolveEngineConnectionProfileId(withLastUsed, { engine: "claude-code" })).toBe(
      "claude-gw",
    );
  });

  it("网关域名只取 host；官方地址与非 http(s) 地址不视为网关", () => {
    expect(engineConnectionUrlHost("https://gw.example:8443/v1?q=secret")).toBe("gw.example:8443");
    expect(engineConnectionUrlHost("file:///etc/passwd")).toBeUndefined();
    expect(isOfficialEngineBaseUrl("claude-code", "https://api.anthropic.com/v1")).toBe(true);
    expect(isOfficialEngineBaseUrl("codex", undefined)).toBe(true);
    expect(
      engineConnectionGatewayHost({
        engine: "codex",
        mode: "apiKey",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBeUndefined();
    expect(
      engineConnectionGatewayHost({
        engine: "claude-code",
        mode: "apiKey",
        baseUrl: "https://gw.example/anthropic",
      }),
    ).toBe("gw.example");
    expect(
      engineConnectionGatewayHost({
        engine: "codex",
        mode: "official",
        baseUrl: "https://x.example",
      }),
    ).toBeUndefined();
  });
});
