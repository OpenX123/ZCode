import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootTraceContext, type ExternalEngineSessionInput } from "@zcode/contracts";
import { createSharedZCodeCredentialStore } from "../src/auth/index.js";
import { resolveEngineConnection } from "../src/external-engine/connection-profile.js";
import type { AcpConnection } from "../src/external-engine/connection.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-engine-profile-"));
  roots.push(root);
  const env = {
    ZCODE_DATA_BASE_DIR: root,
    HOME: root,
    CODEX_HOME: "native-codex-home",
    APP_SERVER_LOGS: "raw-frames.log",
    OPENAI_API_KEY: "inherited-key",
    OPENAI_BASE_URL: "https://inherited-gateway.example/v1",
  };
  const key = "profile-private-key";
  const credentialKey = "external-engine:codex:profile-a";
  const store = createSharedZCodeCredentialStore({ env });
  await store.save(credentialKey, key);
  const profiles = [
    { id: "inherit", mode: "inherit" },
    {
      id: "profile-a",
      mode: "apiKey",
      credentialKey,
      hasApiKey: true,
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
    },
    { id: "profile-b", mode: "official" },
  ];
  await writeFile(
    join(root, "connections.json"),
    JSON.stringify({ activeProfileId: "profile-a", profiles }),
  );
  const input: ExternalEngineSessionInput = {
    sessionId: "local-session",
    engine: "codex",
    cwd: root,
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    onSession: async () => {},
    onConfigOptions: async () => {},
    onUpdate: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
  };
  return { root, env, input, key, store, profiles };
}

describe("Codex 连接身份隔离", () => {
  test("API Key 仅交给原生 provider 请求，普通配置与子进程环境不含密钥", async () => {
    const f = await fixture();
    const onConnectionProfile = vi.fn(async () => {});
    const resolved = await resolveEngineConnection(
      f.root,
      { ...f.input, onConnectionProfile },
      f.env,
    );
    expect(onConnectionProfile).toHaveBeenCalledWith("profile-a");
    expect(resolved.env.CODEX_HOME).toBe(join(f.root, "connections", "profile-a", "codex-home"));
    expect(resolved.env.HOME).toBe(f.env.HOME);
    expect(resolved.env.APP_SERVER_LOGS).toBeUndefined();
    expect(resolved.env.OPENAI_API_KEY).toBeUndefined();
    expect(resolved.env.OPENAI_BASE_URL).toBeUndefined();
    expect(resolved.env.CODEX_CONFIG).toBe('{"model":"model-a"}');
    const request = vi.fn(async () => ({}));
    await resolved.setup!({ request } as unknown as AcpConnection);
    expect(request).toHaveBeenCalledWith("providers/set", {
      providerId: "openai",
      apiType: "openai",
      baseUrl: "https://gateway.example/v1",
      headers: { Authorization: `Bearer ${f.key}` },
    });
    for (const path of [
      join(f.root, "connections.json"),
      join(resolved.env.CODEX_HOME!, "config.toml"),
      f.store.filePath,
    ]) {
      expect(await readFile(path, "utf8")).not.toContain(f.key);
    }
    expect(JSON.stringify(resolved.env)).not.toContain(f.key);
  });

  test("修改默认连接后旧会话仍保持原 profile，无绑定历史沿用用户原配置", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "connections.json"),
      JSON.stringify({ activeProfileId: "profile-b", profiles: f.profiles }),
    );
    const restored = await resolveEngineConnection(
      f.root,
      { ...f.input, externalSessionId: "native-history", connectionProfileId: "profile-a" },
      f.env,
    );
    expect(restored.profile.id).toBe("profile-a");
    expect(restored.env.CODEX_HOME).toContain("profile-a");
    const legacy = await resolveEngineConnection(
      f.root,
      { ...f.input, externalSessionId: "native-history" },
      f.env,
    );
    expect(legacy.profile.id).toBe("inherit");
    expect(legacy.env.CODEX_HOME).toBe(f.env.CODEX_HOME);
    const fresh = await resolveEngineConnection(f.root, f.input, f.env);
    expect(fresh.profile.id).toBe("profile-b");
    expect(fresh.env.OPENAI_BASE_URL).toBeUndefined();
    expect(legacy.env.OPENAI_BASE_URL).toBe(f.env.OPENAI_BASE_URL);
  });

  test("旧原生会话与 fork 缺省按 1.0.7 行为绑定，Codex 为 inherit", async () => {
    const f = await fixture();
    const onConnectionProfile = vi.fn(async () => {});
    const legacy = await resolveEngineConnection(
      f.root,
      { ...f.input, externalSessionId: "native-history", onConnectionProfile },
      f.env,
    );
    expect(legacy.profile.id).toBe("inherit");
    expect(onConnectionProfile).toHaveBeenCalledWith("inherit");
  });

  test("管理连接丢失时明确失败，不静默切换账号或默认网关", async () => {
    const f = await fixture();
    await expect(
      resolveEngineConnection(
        f.root,
        { ...f.input, connectionProfileId: "missing-profile" },
        f.env,
      ),
    ).rejects.toMatchObject({ failure: { code: "configuration" } });
    await f.store.delete("external-engine:codex:profile-a");
    await expect(resolveEngineConnection(f.root, f.input, f.env)).rejects.toMatchObject({
      failure: { code: "authentication" },
    });
  });
});

describe("Claude Code 连接身份", () => {
  async function claudeFixture(profiles: unknown[], lastUsed?: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "zcode-claude-profile-"));
    roots.push(root);
    const env = {
      ZCODE_DATA_BASE_DIR: root,
      HOME: root,
      APP_SERVER_LOGS: "raw-frames.log",
      ANTHROPIC_API_KEY: "inherited-anthropic-key",
      anthropic_auth_token: "inherited-token",
      ANTHROPIC_BASE_URL: "https://inherited-gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "X-Inherited: 1",
      CLAUDE_CODE_USE_BEDROCK: "1",
    };
    const store = createSharedZCodeCredentialStore({ env });
    await writeFile(
      join(root, "connections.json"),
      JSON.stringify({ activeProfileId: "inherit", lastUsed, profiles }),
    );
    const input: ExternalEngineSessionInput = {
      sessionId: "local-session",
      engine: "claude-code",
      cwd: root,
      signal: new AbortController().signal,
      traceContext: createRootTraceContext(),
      onSession: async () => {},
      onConfigOptions: async () => {},
      onUpdate: async () => {},
      requestPermission: async () => ({ outcome: "cancelled" }),
    };
    return { root, env, store, input };
  }

  test("沿用 CLI 原样保留继承的 ANTHROPIC_*，只剔除原生帧日志", async () => {
    const f = await claudeFixture([]);
    const resolved = await resolveEngineConnection(
      f.root,
      { ...f.input, connectionProfileId: "inherit" },
      f.env,
    );
    expect(resolved.profile).toMatchObject({ id: "inherit", engine: "claude-code" });
    expect(resolved.env).toMatchObject({
      ANTHROPIC_API_KEY: "inherited-anthropic-key",
      ANTHROPIC_BASE_URL: "https://inherited-gateway.example",
    });
    expect(resolved.env.APP_SERVER_LOGS).toBeUndefined();
    expect(resolved.setup).toBeUndefined();
  });

  test("无绑定的旧会话与缺省新会话都使用官方登录，去除三项计费变量并记录绑定", async () => {
    const f = await claudeFixture([]);
    for (const input of [{ ...f.input, externalSessionId: "native-history" }, { ...f.input }]) {
      const onConnectionProfile = vi.fn(async () => {});
      const resolved = await resolveEngineConnection(
        f.root,
        { ...input, onConnectionProfile },
        f.env,
      );
      expect(onConnectionProfile).toHaveBeenCalledWith("official");
      expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(resolved.env.anthropic_auth_token).toBeUndefined();
      expect(resolved.env.ANTHROPIC_BASE_URL).toBeUndefined();
      // 1.0.7 只剔除三项；其余继承变量保持原样，不扩大旧会话的行为变化。
      expect(resolved.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Inherited: 1");
    }
  });

  test("API Key 只进入子进程环境：网关用 Bearer + BASE_URL，官方地址用 ANTHROPIC_API_KEY", async () => {
    const key = "claude-profile-secret";
    const f = await claudeFixture(
      [
        {
          id: "gateway",
          engine: "claude-code",
          mode: "apiKey",
          credentialKey: "external-engine:claude-code:gateway",
          hasApiKey: true,
          baseUrl: "https://claude-gw.example/api",
          model: "claude-model-x",
        },
        {
          id: "direct",
          engine: "claude-code",
          mode: "apiKey",
          credentialKey: "external-engine:claude-code:direct",
          hasApiKey: true,
          baseUrl: "https://api.anthropic.com",
        },
      ],
      { "claude-code": "gateway" },
    );
    await f.store.save("external-engine:claude-code:gateway", key);
    await f.store.save("external-engine:claude-code:direct", key);
    const onConnectionProfile = vi.fn(async () => {});
    const gateway = await resolveEngineConnection(
      f.root,
      { ...f.input, onConnectionProfile },
      f.env,
    );
    expect(onConnectionProfile).toHaveBeenCalledWith("gateway");
    expect(gateway.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://claude-gw.example/api",
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: "claude-model-x",
    });
    for (const stripped of [
      "ANTHROPIC_API_KEY",
      "anthropic_auth_token",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
    ])
      expect(gateway.env[stripped]).toBeUndefined();
    expect(gateway.setup).toBeUndefined();
    const direct = await resolveEngineConnection(
      f.root,
      { ...f.input, connectionProfileId: "direct" },
      f.env,
    );
    expect(direct.env.ANTHROPIC_API_KEY).toBe(key);
    expect(direct.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(direct.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // 密钥不在返回的配置、绑定回调、连接文件或凭据文件明文中。
    expect(JSON.stringify(gateway.profile)).not.toContain(key);
    expect(JSON.stringify(onConnectionProfile.mock.calls)).not.toContain(key);
    for (const path of [join(f.root, "connections.json"), f.store.filePath])
      expect(await readFile(path, "utf8")).not.toContain(key);
  });

  test("绑定的 Claude 配置缺失或凭据丢失时明确失败，不回落官方登录", async () => {
    const f = await claudeFixture([
      {
        id: "gateway",
        engine: "claude-code",
        mode: "apiKey",
        credentialKey: "external-engine:claude-code:gateway",
        hasApiKey: true,
        baseUrl: "https://claude-gw.example",
      },
    ]);
    await expect(
      resolveEngineConnection(f.root, { ...f.input, connectionProfileId: "gateway" }, f.env),
    ).rejects.toMatchObject({ failure: { code: "authentication" } });
    await expect(
      resolveEngineConnection(f.root, { ...f.input, connectionProfileId: "missing" }, f.env),
    ).rejects.toMatchObject({ failure: { code: "configuration" } });
  });
});
