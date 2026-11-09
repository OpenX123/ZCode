import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import {
  createExternalEngineService,
  type ExternalEngineServiceOptions,
} from "../src/external-engine/node.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "external-engine-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const name of ["claude", "codex", "npm"]) {
    const path = join(bin, process.platform === "win32" ? `${name}.EXE` : name);
    await writeFile(path, "fake");
    await chmod(path, 0o755);
  }
  const env = {
    PATH: bin,
    HOME: join(root, "real-home"),
    ANTHROPIC_API_KEY: "must-be-stripped",
  };
  const enginesDir = join(root, "engines");
  const install = async (engine: ExternalSessionEngine) => {
    const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
    const directory = join(enginesDir, managedAdapterInstallDirName(runtime));
    const entry = join(directory, ...managedAdapterEntrySegments(runtime));
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "fake");
    await writeFile(
      join(directory, "node_modules", ...runtime.adapterPackage.split("/"), "package.json"),
      JSON.stringify({ version: runtime.adapterVersion }),
    );
    return directory;
  };
  const run = vi.fn<NonNullable<ExternalEngineServiceOptions["runCommand"]>>(
    async (_command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "2.1.310 (Claude Code)", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "sensitive@example.invalid",
          token: "secret-token",
        }),
        stderr: "",
      };
    },
  );
  const credentialValues = new Map<string, string>();
  const credentials = {
    load: async (key: string) => credentialValues.get(key) ?? null,
    save: async (key: string, value: string) => {
      credentialValues.set(key, value);
    },
    delete: async (key: string) => {
      credentialValues.delete(key);
    },
  };
  const testConnection = vi.fn<NonNullable<ExternalEngineServiceOptions["testConnection"]>>(
    async () => ({ status: "success", latencyMs: 1200 }),
  );
  const service = createExternalEngineService({
    enginesDir,
    env,
    runCommand: run,
    credentials,
    testConnection,
  });
  return {
    root,
    env,
    enginesDir,
    run,
    service,
    install,
    credentials,
    credentialValues,
    testConnection,
  };
}

describe("外部引擎 Host 服务", () => {
  it("诊断返回四类结构化检查与来源，认证只关联实际配置且不触发模型请求", async () => {
    const f = await fixture();
    await f.install("claude-code");
    const status = await f.service.getStatus("claude-code");
    expect(status.checks?.map((check) => check.id)).toEqual([
      "cli",
      "adapter",
      "authentication",
      "route",
    ]);
    expect(status.checks?.find((check) => check.id === "authentication")).toMatchObject({
      connectionProfileId: status.connectionProfileId,
      state: "passed",
      source: "cli",
    });
    expect(status.checks?.find((check) => check.id === "route")).toMatchObject({
      state: "unknown",
      source: "profile",
    });
    expect(f.testConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(status.checks)).not.toContain("secret-token");
    expect(JSON.stringify(status.checks)).not.toContain("sensitive@example");
    f.service.disposeAll();
  });

  it("取消某引擎诊断只中止其命令，另一引擎仍完成且旧检查不广播", async () => {
    const f = await fixture();
    await f.install("claude-code");
    await f.install("codex");
    const started = Promise.withResolvers<void>();
    const changed = vi.fn();
    f.service.onStatusChanged(changed);
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args, options) => {
      if (args[0] === "auth") {
        started.resolve();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("external_engine_process_interrupted")),
            { once: true },
          ),
        );
      }
      return original(command, args, options);
    });
    const checking = f.service.getStatus("claude-code");
    const rejected = expect(checking).rejects.toThrow("external_engine_process_interrupted");
    await started.promise;
    await f.service.invalidateStatus!("claude-code", "check");
    await rejected;
    expect((await f.service.getStatus("codex")).ready).toBe(true);
    expect(changed.mock.calls.map(([status]) => status.engine)).toEqual(["codex"]);
    f.service.disposeAll();
  });

  it("取消安装中止 npm 子进程，允许之后重试且不影响发送快检", async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args, options) => {
      if (args[0] === "install") {
        started.resolve();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("external_engine_process_interrupted")),
            { once: true },
          ),
        );
      }
      return original(command, args, options);
    });
    const installing = f.service.installAdapter("claude-code");
    const rejected = expect(installing).rejects.toThrow("external_engine_install_failed");
    await started.promise;
    await f.service.invalidateStatus!("claude-code", "install");
    await rejected;
    await f.install("codex");
    f.run.mockClear();
    expect(await f.service.isLaunchReady!("codex")).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
    f.service.disposeAll();
  });

  it.each(["codex", "claude-code"] as const)(
    "%s 沿用 CLI 的 API Key 身份不代表远端认证通过",
    async (engine) => {
      const f = await fixture();
      await f.install(engine);
      await f.service.updateConnectionProfiles!({ type: "select", engine, profileId: "inherit" });
      f.run.mockImplementation(async (_command, args) =>
        args[0] === "--version"
          ? { code: 0, stdout: "2.1.310", stderr: "" }
          : {
              code: 0,
              stdout:
                engine === "codex"
                  ? "Logged in using an API key"
                  : JSON.stringify({ loggedIn: true, authMethod: "api_key" }),
              stderr: "",
            },
      );
      const status = await f.service.getStatus(engine);
      expect(status.auth).toMatchObject({ state: "loggedIn", label: "apiKey" });
      expect(status.ready).toBe(true);
      expect(status.checks?.find((check) => check.id === "authentication")).toMatchObject({
        state: "unknown",
        source: "cli",
        connectionProfileId: "inherit",
        actions: ["test"],
      });
      expect(f.testConnection).not.toHaveBeenCalled();
      f.service.disposeAll();
    },
  );

  it("API Key 检查只确认保存状态，不冒充远端认证通过", async () => {
    const f = await fixture();
    await f.install("codex");
    const created = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "apiKey",
      baseUrl: "https://gateway.example/v1",
      apiKey: "private-gateway-key",
    });
    const status = await f.service.getStatus("codex");
    expect(status.checks?.find((check) => check.id === "authentication")).toMatchObject({
      state: "unknown",
      source: "credentialStore",
      connectionProfileId: created.profileId,
    });
    expect(status.checks?.find((check) => check.id === "route")).toMatchObject({
      gatewayHost: "gateway.example",
      connectionProfileId: created.profileId,
    });
    expect(f.testConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("private-gateway-key");
    f.service.disposeAll();
  });

  it("发送门禁不启动任何CLI检测，配置变化使廉价缓存失效", async () => {
    const f = await fixture();
    await f.install("codex");
    expect(await f.service.isLaunchReady!("codex")).toBe(true);
    await rm(join(f.enginesDir, managedAdapterInstallDirName(EXTERNAL_ENGINE_RUNTIMES.codex)), {
      recursive: true,
      force: true,
    });
    expect(await f.service.isLaunchReady!("codex")).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
    await f.service.updateConnectionProfiles!({
      type: "select",
      engine: "codex",
      profileId: "inherit",
    });
    expect(await f.service.isLaunchReady!("codex")).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    f.service.disposeAll();
  });
  it("未登录仍允许原生握手，重复和并发检查复用缓存", async () => {
    const f = await fixture();
    await f.install("codex");
    f.run.mockResolvedValue({ code: 1, stdout: "", stderr: "Not logged in" });
    const results = await Promise.all([f.service.getStatus("codex"), f.service.getStatus("codex")]);
    expect(results[0].ready).toBe(true);
    expect(results[0].auth.state).toBe("loggedOut");
    await f.service.getStatus("codex");
    expect(f.run).toHaveBeenCalledTimes(2);
    f.service.disposeAll();
  });

  it("管理连接只返回密钥存在性，编辑生成新 ID、隐藏旧配置并沿用旧密钥", async () => {
    const f = await fixture();
    const first = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "apiKey",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      apiKey: "private-key-test",
    });
    expect(JSON.stringify(first)).not.toContain("private-key-test");
    const created = first.connections.profiles.find((item) => item.id === first.profileId);
    expect(created).toMatchObject({
      hasApiKey: true,
      gatewayHost: "gateway.example",
    });
    expect(created).not.toHaveProperty("credentialKey");
    expect(first.connections.defaults.codex).toBe(first.profileId);
    const second = await f.service.updateConnectionProfiles!({
      type: "edit",
      engine: "codex",
      profileId: first.profileId!,
      mode: "apiKey",
      baseUrl: "https://gateway.example/v1",
      model: "model-b",
    });
    expect(second.profileId).not.toBe(first.profileId);
    const profiles = await f.service.getConnectionProfiles!();
    expect(profiles.defaults.codex).toBe(second.profileId);
    expect(profiles.profiles.find((item) => item.id === first.profileId)?.hidden).toBe(true);
    expect(f.credentialValues.get(`external-engine:codex:${second.profileId}`)).toBe(
      "private-key-test",
    );
    // 旧配置与凭据保留，已绑定会话继续解析；连接文件不含密钥且保持旧版可读字段。
    expect(f.credentialValues.get(`external-engine:codex:${first.profileId}`)).toBe(
      "private-key-test",
    );
    const file = await readFile(join(f.enginesDir, "connections.json"), "utf8");
    expect(file).not.toContain("private-key-test");
    expect(JSON.parse(file)).toMatchObject({
      activeProfileId: second.profileId,
    });
    expect(JSON.parse(file).profiles.some((item: { id: string }) => item.id === "inherit")).toBe(
      true,
    );
    f.service.disposeAll();
  });
  it("删除只隐藏配置，内置配置与隐藏配置不可选，写入后广播最新视图", async () => {
    const f = await fixture();
    const changed = vi.fn();
    f.service.onConnectionProfilesChanged!(changed);
    const { profileId } = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "claude-code",
      name: "公司网关",
      mode: "apiKey",
      baseUrl: "https://gateway.example/anthropic",
      apiKey: "claude-private-key",
    });
    expect((await f.service.getConnectionProfiles!()).defaults["claude-code"]).toBe(profileId);
    await f.service.updateConnectionProfiles!({
      type: "delete",
      engine: "claude-code",
      profileId: profileId!,
    });
    const view = await f.service.getConnectionProfiles!();
    expect(view.defaults["claude-code"]).toBe("official");
    expect(view.profiles.find((item) => item.id === profileId)).toMatchObject({
      hidden: true,
      name: "公司网关",
    });
    expect(f.credentialValues.has(`external-engine:claude-code:${profileId}`)).toBe(true);
    for (const command of [
      { type: "select", engine: "claude-code", profileId: profileId! },
      { type: "delete", engine: "claude-code", profileId: "official" },
      { type: "select", engine: "codex", profileId: "official" },
      { type: "create", engine: "codex", mode: "inherit" },
    ] as const)
      await expect(f.service.updateConnectionProfiles!(command)).rejects.toThrow(
        "external_engine_connection_invalid",
      );
    await expect(
      f.service.updateConnectionProfiles!({
        type: "create",
        engine: "codex",
        mode: "apiKey",
      }),
    ).rejects.toThrow("external_engine_api_key_missing");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(changed.mock.calls)).not.toContain("claude-private-key");
    f.service.disposeAll();
  });
  it("官方登录独占专用身份目录，取消及释放服务等待登录退出", async () => {
    const f = await fixture();
    await f.install("codex");
    const { profileId } = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "official",
    });
    const profile = { id: profileId! };
    await f.service.getStatus("codex");
    let started!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.run.mockImplementation(async (_command, args, options) => {
      expect(args).toEqual(["login"]);
      expect(options.env.CODEX_HOME).toBe(
        join(f.enginesDir, "connections", profile.id, "codex-home"),
      );
      expect(options.env.HOME).toBe(f.env.HOME);
      expect(options.env.APP_SERVER_LOGS).toBeUndefined();
      started();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("external_engine_process_interrupted"));
          },
          { once: true },
        ),
      );
    });
    const pending = f.service.login!(profile.id);
    const rejected = expect(pending).rejects.toThrow("external_engine_process_interrupted");
    await expect(f.service.login!(profile.id)).rejects.toThrow("external_engine_login_running");
    await loginStarted;
    await f.service.disposeAllAndWait();
    await rejected;
    expect(
      f.run.mock.calls.filter(([, args]) => args.length === 1 && args[0] === "login"),
    ).toHaveLength(1);
  });
  it("Codex 官方配置尚未登录时默认回退本地 CLI 配置", async () => {
    const f = await fixture();
    await f.install("codex");
    const { profileId } = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "official",
    });
    const view = await f.service.getConnectionProfiles!();
    expect(view.defaults.codex).toBe("inherit");
    expect(view.profiles.find((profile) => profile.id === profileId)?.mode).toBe("official");
    f.service.disposeAll();
  });
  it("官方身份诊断使用管理目录，登录预检不等待版本和身份诊断", async () => {
    const f = await fixture();
    await f.install("codex");
    const { profileId } = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "official",
    });
    const profile = { id: profileId! };
    const home = join(f.enginesDir, "connections", profile.id, "codex-home");
    f.run.mockImplementation(async (_command, args, options) => {
      expect(options.env.CODEX_HOME).toBe(home);
      expect(options.env.HOME).toBe(f.env.HOME);
      if (args[0] === "login" && args.length === 1) return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "--version") return { code: 0, stdout: "codex 1.0.0", stderr: "" };
      return { code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    });
    await f.service.login!(profile.id);
    expect(f.run.mock.calls.map(([, args]) => args)).toEqual([["login"]]);
    expect((await f.service.getStatus("codex")).auth).toEqual({
      state: "loggedIn",
      label: "subscription",
    });
    expect(f.run).toHaveBeenCalledTimes(3);
    f.service.disposeAll();
  });
  it("API Key 身份诊断只检查对应凭据，不借用官方登录状态", async () => {
    const f = await fixture();
    await f.install("codex");
    const { profileId } = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "apiKey",
      apiKey: "profile-key-fixture",
    });
    const profile = { id: profileId! };
    f.run.mockImplementation(async (_command, args, options) => {
      expect(options.env.CODEX_HOME).toBe(
        join(f.enginesDir, "connections", profile.id, "codex-home"),
      );
      expect(args).toEqual(["--version"]);
      return { code: 0, stdout: "codex 1.0.0", stderr: "" };
    });
    const status = await f.service.getStatus("codex");
    expect(status.auth).toEqual({ state: "loggedIn", label: "apiKey" });
    expect(JSON.stringify(status)).not.toContain("profile-key-fixture");
    expect(f.run).toHaveBeenCalledOnce();
    f.service.disposeAll();
  });
  it("切换连接后不复用在途旧身份诊断，迟到结果不得覆盖新缓存或广播", async () => {
    const f = await fixture();
    await f.install("codex");
    const previous = Promise.withResolvers<{
      code: number;
      stdout: string;
      stderr: string;
    }>();
    const started = Promise.withResolvers<void>();
    f.run.mockImplementation(async (_command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "codex 1.0.0", stderr: "" };
      started.resolve();
      return previous.promise;
    });
    const changed = vi.fn();
    f.service.onStatusChanged(changed);
    const old = f.service.getStatus("codex");
    await started.promise;
    await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "codex",
      mode: "apiKey",
      apiKey: "fresh-key-fixture",
    });
    const fresh = f.service.refreshStatus!("codex");
    expect(fresh).not.toBe(old);
    previous.resolve({ code: 1, stdout: "", stderr: "Not logged in" });
    await old;
    expect((await fresh).auth).toEqual({ state: "loggedIn", label: "apiKey" });
    expect((await f.service.getStatus("codex")).auth).toEqual({
      state: "loggedIn",
      label: "apiKey",
    });
    expect(changed.mock.calls.map(([status]) => status.auth.state)).not.toContain("loggedOut");
    f.service.disposeAll();
  });
  it.skipIf(process.platform === "win32")(
    "PATH 缺 node 时直接用当前运行时检测 npm 官方 JavaScript CLI",
    async () => {
      const f = await fixture();
      await f.install("codex");
      const cli = join(f.root, "official.cjs");
      await writeFile(
        cli,
        '#!/usr/bin/env node\nconsole.log(process.argv.includes("--version")?"codex-cli 1.0.0":"Logged in using ChatGPT");',
        { mode: 0o755 },
      );
      await rm(join(f.env.PATH, "codex"));
      await symlink(cli, join(f.env.PATH, "codex"));
      const service = createExternalEngineService({
        enginesDir: f.enginesDir,
        env: f.env,
      });
      try {
        const status = await service.getStatus("codex");
        expect(status.officialCli.version).toBe("1.0.0");
        expect(status.ready).toBe(true);
        expect(status.auth).toEqual({
          state: "loggedIn",
          label: "subscription",
        });
      } finally {
        await service.disposeAllAndWait();
        f.service.disposeAll();
      }
    },
  );
  it("只读检测不安装，丢弃身份和密钥并清理 Claude API 环境", async () => {
    const f = await fixture();
    const status = await f.service.getStatus("claude-code");
    expect(status.ready).toBe(false);
    expect(status.auth).toEqual({ state: "loggedIn", label: "subscription" });
    expect(JSON.stringify(status)).not.toMatch(/sensitive|secret-token/);
    expect(f.run.mock.calls.map(([, args]) => args)).toEqual([["--version"], ["auth", "status"]]);
    expect(f.run.mock.calls[1][2].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(f.run.mock.calls[1][2].env.anthropic_auth_token).toBeUndefined();
    expect(f.run.mock.calls[1][2].env.Anthropic_Base_Url).toBeUndefined();
    expect(f.run.mock.calls[1][2].env.HOME).toBe(f.env.HOME);
    f.service.disposeAll();
  });

  it("安装是显式 single flight，使用官方 registry 和锁定版本", async () => {
    const f = await fixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.run.mockImplementation(async (_command, args) => {
      if (args[0] === "install") {
        await wait;
        await f.install("claude-code");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--version") return { code: 0, stdout: "2.1.310", stderr: "" };
      return {
        code: 0,
        stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
        stderr: "",
      };
    });
    const first = f.service.installAdapter("claude-code");
    const second = f.service.installAdapter("claude-code");
    expect(first).toBe(second);
    release();
    expect((await first).ready).toBe(true);
    const installs = f.run.mock.calls.filter(([, args]) => args[0] === "install");
    expect(installs).toHaveLength(1);
    expect(installs[0][1]).toContain("--registry=https://registry.npmjs.org");
    expect(installs[0][1]).toContain("@agentclientprotocol/claude-agent-acp@0.95.0");
    expect(installs[0][1]).toContain(join(f.enginesDir, "claude-code@0.95.0"));
    f.service.disposeAll();
  });

  it("安装失败不会泄露命令输出，失败后允许显式重试", async () => {
    const f = await fixture();
    f.run.mockResolvedValue({
      code: 1,
      stdout: "private-token",
      stderr: "private-email",
    });
    await expect(f.service.installAdapter("codex")).rejects.toThrow(
      "external_engine_install_failed",
    );
    await expect(f.service.installAdapter("codex")).rejects.toThrow(
      "external_engine_install_failed",
    );
    expect(f.run).toHaveBeenCalledTimes(2);
    f.service.disposeAll();
  });

  it("Codex 登录状态只保留类别，未知响应不误判登录成功", async () => {
    const f = await fixture();
    await f.install("codex");
    f.run.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "Logged in using an API key - private-token",
    });
    expect((await f.service.getStatus("codex")).auth).toEqual({
      state: "loggedIn",
      label: "apiKey",
    });
    f.run.mockResolvedValue({ code: 1, stdout: "", stderr: "Not logged in" });
    expect((await f.service.refreshStatus!("codex")).auth.state).toBe("loggedOut");
    f.run.mockResolvedValue({
      code: 0,
      stdout: "unexpected sensitive-output",
      stderr: "",
    });
    const unknown = await f.service.refreshStatus!("codex");
    expect(unknown.auth.state).toBe("unknown");
    expect(unknown.ready).toBe(true);
    f.service.disposeAll();
  });

  it("PATH 缺官方 CLI 时只使用已安装 adapter 的官方副本", async () => {
    const f = await fixture();
    const directory = await f.install("codex");
    const bundledDescriptor = EXTERNAL_ENGINE_RUNTIMES.codex.bundledOfficialCli;
    if (bundledDescriptor.kind !== "javascript") throw new Error("fixture_cli_kind");
    const bundled = join(directory, ...bundledDescriptor.entry.split("/"));
    await mkdir(dirname(bundled), { recursive: true });
    await writeFile(bundled, "fake");
    const service = createExternalEngineService({
      enginesDir: f.enginesDir,
      env: { HOME: f.env.HOME, PATH: "" },
      runCommand: f.run,
    });
    expect((await service.getStatus("codex")).ready).toBe(true);
    expect(f.run.mock.calls[0][0]).toBe(process.execPath);
    expect(f.run.mock.calls[0][1]).toEqual([bundled, "--version"]);
    expect(f.run.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBe("1");
    service.disposeAll();
    f.service.disposeAll();
  });

  it("释放服务会取消正在安装的子进程，不推送迟到就绪事件", async () => {
    const f = await fixture();
    let started!: () => void;
    const installed = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.run.mockImplementation(async (_command, _args, options) => {
      started();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("external_engine_process_interrupted")),
          { once: true },
        ),
      );
    });
    const changed = vi.fn();
    f.service.onStatusChanged(changed);
    const pending = f.service.installAdapter("codex");
    const rejected = expect(pending).rejects.toThrow("external_engine_install_failed");
    await installed;
    await f.service.disposeAllAndWait();
    await rejected;
    expect(changed).not.toHaveBeenCalled();
  });
  it("未知检测错误继续抛出，释放服务取消所有在途安装", async () => {
    const f = await fixture();
    f.run.mockRejectedValue(new Error("unexpected internal failure"));
    await expect(f.service.getStatus("claude-code")).rejects.toThrow("unexpected internal failure");
    f.service.disposeAll();
    await expect(f.service.installAdapter("claude-code")).rejects.toThrow(
      "external_engine_service_disposed",
    );
  });
});

describe("Claude Code 三种连接与网关状态", () => {
  it("沿用 CLI 保留继承的 ANTHROPIC_*，状态显示环境网关而不是未登录", async () => {
    const f = await fixture();
    await f.install("claude-code");
    await f.service.updateConnectionProfiles!({
      type: "select",
      engine: "claude-code",
      profileId: "inherit",
    });
    const service = createExternalEngineService({
      enginesDir: f.enginesDir,
      env: {
        ...f.env,
        ANTHROPIC_BASE_URL: "https://claude-gw.example/api?token=leak",
      },
      runCommand: f.run,
    });
    f.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "2.1.310", stderr: "" }
        : { code: 0, stdout: '{"loggedIn":false}', stderr: "" },
    );
    const status = await service.getStatus("claude-code");
    expect(status.connectionProfileId).toBe("inherit");
    expect(status.auth).toEqual({
      state: "loggedOut",
      gatewayHost: "claude-gw.example",
    });
    expect(status.inheritedGatewayHost).toBe("claude-gw.example");
    expect(JSON.stringify(status)).not.toMatch(/token=leak|must-be-stripped/);
    expect(f.run.mock.calls[1]?.[2].env.ANTHROPIC_API_KEY).toBe("must-be-stripped");
    service.disposeAll();
    f.service.disposeAll();
  });

  it("官方登录去除继承变量但识别 settings.json 的网关，只读取该键", async () => {
    const f = await fixture();
    await f.install("claude-code");
    await mkdir(join(f.env.HOME, ".claude"), { recursive: true });
    await writeFile(
      join(f.env.HOME, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://settings-gw.example/v1",
          ANTHROPIC_AUTH_TOKEN: "x",
        },
        apiKeyHelper: "secret-helper",
      }),
    );
    const status = await f.service.getStatus("claude-code");
    expect(status.connectionProfileId).toBe("official");
    expect(status.auth).toMatchObject({
      state: "loggedIn",
      gatewayHost: "settings-gw.example",
    });
    expect(JSON.stringify(status)).not.toMatch(/secret-helper|"x"/);
    expect(f.run.mock.calls[1]?.[2].env.ANTHROPIC_API_KEY).toBeUndefined();
    f.service.disposeAll();
  });

  it("API Key 配置只检查凭据并按地址区分官方 Key 与网关", async () => {
    const f = await fixture();
    await f.install("claude-code");
    f.run.mockResolvedValue({ code: 0, stdout: "2.1.310", stderr: "" });
    await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "claude-code",
      mode: "apiKey",
      apiKey: "claude-private-key",
    });
    expect((await f.service.getStatus("claude-code")).auth).toEqual({
      state: "loggedIn",
      label: "apiKey",
    });
    await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "claude-code",
      mode: "apiKey",
      baseUrl: "https://gw.example/anthropic",
      apiKey: "claude-private-key",
    });
    const status = await f.service.getStatus("claude-code");
    expect(status.auth).toEqual({
      state: "loggedIn",
      label: "apiKey",
      gatewayHost: "gw.example",
    });
    expect(f.run.mock.calls.every(([, args]) => args[0] === "--version")).toBe(true);
    expect(JSON.stringify(status)).not.toContain("claude-private-key");
    f.service.disposeAll();
  });

  it("Codex 沿用 CLI 读取 config.toml 当前 provider 的网关 host，不再显示未登录", async () => {
    const f = await fixture();
    await f.install("codex");
    await mkdir(join(f.env.HOME, ".codex"), { recursive: true });
    await writeFile(
      join(f.env.HOME, ".codex", "config.toml"),
      [
        'model_provider = "corp"',
        'profile = "work"',
        "[profiles.work]",
        'model_provider = "gateway"',
        "[model_providers.corp]",
        'base_url = "https://corp.example/v1"',
        "[model_providers.gateway]",
        'base_url = "https://codex-gw.example:8443/v1"',
        'experimental_bearer_token = "toml-secret"',
      ].join("\n"),
    );
    f.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "codex 1.0.0", stderr: "" }
        : { code: 1, stdout: "", stderr: "Not logged in" },
    );
    const status = await f.service.getStatus("codex");
    expect(status.auth).toEqual({
      state: "loggedOut",
      gatewayHost: "codex-gw.example:8443",
    });
    expect(JSON.stringify(status)).not.toContain("toml-secret");
    f.service.disposeAll();
  });

  it("Claude 官方登录按钮运行 claude auth login --claudeai，可取消且去除继承的 API 变量", async () => {
    const f = await fixture();
    await f.install("claude-code");
    let started!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.run.mockImplementation(async (_command, args, options) => {
      expect(args).toEqual(["auth", "login", "--claudeai"]);
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.env.HOME).toBe(f.env.HOME);
      started();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("external_engine_process_interrupted")),
          { once: true },
        ),
      );
    });
    const pending = f.service.login!("official");
    await loginStarted;
    await f.service.cancelLogin!();
    await expect(pending).rejects.toThrow("external_engine_process_interrupted");
    await expect(f.service.login!("inherit")).rejects.toThrow("external_engine_connection_invalid");
    f.service.disposeAll();
  });
});

describe("测试连接", () => {
  it("委托 CLI 正式启动路径，单个在途测试可取消，日志与结果不含密钥", async () => {
    const f = await fixture();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { profileId } = await f.service.updateConnectionProfiles!({
      type: "create",
      engine: "claude-code",
      mode: "apiKey",
      baseUrl: "https://gw.example",
      apiKey: "claude-private-key",
    });
    const input = {
      engine: "claude-code" as const,
      profileId: profileId!,
      workspacePath: f.root,
    };
    expect(await f.service.testConnection!(input)).toEqual({
      status: "success",
      latencyMs: 1200,
    });
    expect(f.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ...input, signal: expect.any(AbortSignal) }),
    );
    const testStarted = Promise.withResolvers<void>();
    f.testConnection.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("transport closed")), {
            once: true,
          });
          testStarted.resolve();
        }),
    );
    const running = f.service.testConnection!(input);
    await expect(f.service.testConnection!(input)).rejects.toThrow(
      "external_engine_connection_test_running",
    );
    await testStarted.promise;
    await f.service.cancelConnectionTest!();
    expect(await running).toEqual({ status: "cancelled" });
    // 配置读取期间取消：不再启动 CLI 测试。
    const early = f.service.testConnection!(input);
    await f.service.cancelConnectionTest!();
    expect(await early).toEqual({ status: "cancelled" });
    expect(f.testConnection).toHaveBeenCalledTimes(2);
    f.testConnection.mockResolvedValueOnce({
      status: "failed",
      latencyMs: 800,
      failure: {
        code: "authentication",
        httpStatus: 401,
        requestId: "req_1",
        message: "bad key",
      },
    });
    expect((await f.service.testConnection!(input)).status).toBe("failed");
    await expect(
      f.service.testConnection!({ ...input, profileId: "missing-profile" }),
    ).rejects.toThrow("external_engine_connection_invalid");
    await expect(f.service.testConnection!({ ...input, workspacePath: " " })).rejects.toThrow(
      "external_engine_connection_test_unavailable",
    );
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("external engine connection test finished");
    expect(logged).not.toMatch(/claude-private-key|bad key/);
    expect(JSON.stringify(f.testConnection.mock.calls)).not.toContain("claude-private-key");
    info.mockRestore();
    f.service.disposeAll();
  });
});
