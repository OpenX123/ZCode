import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
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
  const env = { PATH: bin, HOME: join(root, "real-home"), ANTHROPIC_API_KEY: "must-be-stripped" };
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
  const service = createExternalEngineService({ enginesDir, env, runCommand: run });
  return { root, env, enginesDir, run, service, install };
}

describe("外部引擎 Host 服务", () => {
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
      const service = createExternalEngineService({ enginesDir: f.enginesDir, env: f.env });
      try {
        const status = await service.getStatus("codex");
        expect(status.officialCli.version).toBe("1.0.0");
        expect(status.ready).toBe(true);
        expect(status.auth).toEqual({ state: "loggedIn", label: "subscription" });
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
      return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: "" };
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
    f.run.mockResolvedValue({ code: 1, stdout: "private-token", stderr: "private-email" });
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
    expect((await f.service.getStatus("codex")).auth.state).toBe("loggedOut");
    f.run.mockResolvedValue({ code: 0, stdout: "unexpected sensitive-output", stderr: "" });
    expect((await f.service.getStatus("codex")).ready).toBe(false);
    f.service.disposeAll();
  });

  it("PATH 缺官方 CLI 时只使用已安装 adapter 的官方副本", async () => {
    const f = await fixture();
    const directory = await f.install("claude-code");
    const bundled = join(
      directory,
      ...EXTERNAL_ENGINE_RUNTIMES["claude-code"].bundledOfficialCliEntry.split("/"),
    );
    await mkdir(dirname(bundled), { recursive: true });
    await writeFile(bundled, "fake");
    const service = createExternalEngineService({
      enginesDir: f.enginesDir,
      env: { HOME: f.env.HOME, PATH: "" },
      runCommand: f.run,
    });
    expect((await service.getStatus("claude-code")).ready).toBe(true);
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
