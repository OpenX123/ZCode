import { execFile } from "node:child_process";
import { access, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ExternalEngineConnectionError,
  createRootTraceContext,
  type ExternalEnginePort,
  type ExternalEngineTurnInput,
} from "@zcode/contracts";
import {
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import { createSharedZCodeCredentialStore } from "../src/auth/index.js";
import {
  adapterLaunchArgs,
  CLAUDE_GIT_BASH_ENV,
  ensureClaudeGitBashPath,
  ensureNodeRuntimeOnPath,
  SCRUB_ELECTRON_RUN_AS_NODE_IMPORT,
  windowsNodeShimContent,
} from "../src/external-engine/adapter-env.js";
import {
  createExternalEnginePort,
  runExternalEngineConnectionTest,
} from "../src/external-engine/index.js";
import { SUBAGENT_NAMING_INSTRUCTIONS } from "../src/external-engine/connection.js";
import nativeCatalog from "./fixtures/codex-native-config-options.json";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// 受控 ACP 进程：按 FIXTURE_MODE 返回正文、失败通知或等待取消；report 模式回显 argv 与关键环境变量。
const fixtureScript = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const sid = "native-session";
const mode = process.env.FIXTURE_MODE || "ok";
const nativeCatalog = JSON.parse(process.env.FIXTURE_CONFIG_OPTIONS || "[]");
if (process.env.FIXTURE_CWD_FILE) fs.writeFileSync(process.env.FIXTURE_CWD_FILE, process.cwd());
let prompt;
let sessionParams;
const text = (value) => send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } });
const info = (meta) => send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "session_info_update", _meta: meta } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, ...(process.env.FIXTURE_SYSTEM_PROMPT_CAP ? { systemPrompt: {} } : {}) } } } });
  else if (message.method === "session/new" && mode === "session-params") { sessionParams = message.params; send({ id: message.id, result: { sessionId: sid } }); }
  else if ((message.method === "session/new" || message.method === "session/resume") && mode.startsWith("native-catalog")) {
    if (mode === "native-catalog-notification-first") {
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "config_option_update", configOptions: nativeCatalog } } });
      send({ method: "session/update", params: { sessionId: "another-native-session", update: { sessionUpdate: "config_option_update", configOptions: [] } } });
    }
    send({ id: message.id, result: { sessionId: sid, configOptions: mode === "native-catalog-notification-first" ? nativeCatalog.filter(option => option.id !== "reasoning_effort") : nativeCatalog } });
  }
  else if (message.method === "session/new" && mode === "null-description") send({ id: message.id, result: { sessionId: sid, configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "gw-model", options: [{ value: "gw-model", name: "6.1 Sol", description: null, _meta: { jetbrains: { air: { version: 1, kind: "standard" } } } }, { value: "gpt-5.5", name: "5.5", description: "Frontier model" }] }] } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: sid } });
  else if (message.method === "session/cancel") send({ id: prompt.id, result: { stopReason: "cancelled" } });
  else if (message.method === "session/prompt") {
    prompt = message;
    const env = {};
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ELECTRON_RUN_AS_NODE", "ZCODE_TOOL_ENV_PASSTHROUGH_JSON"]) env[key] = process.env[key];
    if (mode === "report") { text(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv, env })); send({ id: message.id, result: { stopReason: "end_turn" } }); }
    else if (mode === "session-params") { text(JSON.stringify(sessionParams)); send({ id: message.id, result: { stopReason: "end_turn" } }); }
    else if (mode === "codex-error") {
      // 重试中的 warning 不结束测试；Codex 重试用尽后发终态 error（willRetry=false）。
      info({ codex: { error: { message: "unexpected status 401 Unauthorized: bad key sk-abcdefghijklmnop request id: req_123", httpStatus: 401, willRetry: true } } });
      setTimeout(() => info({ codex: { error: { message: "unexpected status 401 Unauthorized: bad key sk-abcdefghijklmnop request id: req_123", httpStatus: 401, willRetry: false } } }), 50);
    }
    else if (mode === "typed-warning-ok") {
      // 本机 Codex 2.2.2 实测形状：未声明 session.notices 时 WarningEvent 以 typed failure（warning）上报。
      info({ jetbrains: { air: { sessionFailure: { id: "turn-1:notice:1", revision: 1, severity: "warning", category: "unknown", title: "Model metadata for gw-model not found. Defaulting to fallback metadata; this can degrade performance and cause issues.", actions: [] } } } });
      text("OK"); send({ id: message.id, result: { stopReason: "end_turn" } });
    }
    else if (mode === "notice-ok") {
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "notice", severity: "warning", title: "Model metadata not found", description: "token sk-abcdefghijklmnop leaked" } } });
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "notice", severity: "warning", title: "Model metadata not found", description: "token sk-abcdefghijklmnop leaked" } } });
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "notice", severity: "info", title: "Model rerouted" } } });
      text("OK"); send({ id: message.id, result: { stopReason: "end_turn" } });
    }
    else if (mode === "air-error") info({ jetbrains: { air: { sessionFailure: { id: "f1", severity: "error", category: "access", title: "Sign in to continue using Claude." } } } });
    else if (mode === "rpc-error") send({ id: message.id, error: { code: -32603, message: "Internal error", data: { message: "upstream 503 Service Unavailable", httpStatus: 503 } } });
    else if (mode === "text-error") { text("unexpected status 401 Unauthorized at https://gw.example/v1?key=leak token sk-abcdefghijklmnop"); send({ id: message.id, result: { stopReason: "end_turn" } }); }
    else if (mode === "usage") send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1234, thoughtTokens: 300, cachedReadTokens: 4 } } });
    else if (mode === "hang") {}
    else { text("OK"); send({ id: message.id, result: { stopReason: "end_turn" } }); }
  }
});
`;

async function setup(engine: "claude-code" | "codex", env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-acp-connection-"));
  roots.push(root);
  const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
  const entry = join(root, managedAdapterInstallDirName(runtime), ...managedAdapterEntrySegments(runtime));
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, fixtureScript);
  const portEnv = {
    ...process.env,
    [EXTERNAL_ENGINES_DIR_ENV]: root,
    [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
    ZCODE_DATA_BASE_DIR: root,
    ...env,
  };
  return { root, env: portEnv, port: createExternalEnginePort({ env: portEnv, executable: process.execPath }) };
}

function turn(engine: "claude-code" | "codex", updates: Record<string, unknown>[] = []) {
  return {
    sessionId: "local-session",
    engine,
    cwd: tmpdir(),
    prompt: [{ type: "text", text: "report" }],
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    onSession: async () => {},
    onConfigOptions: async () => {},
    onUpdate: async (update: Record<string, unknown>) => {
      updates.push(update);
    },
    requestPermission: async () => ({ outcome: "cancelled" as const }),
  } satisfies ExternalEngineTurnInput;
}

async function reported(port: ExternalEnginePort, input: ExternalEngineTurnInput) {
  const updates: Record<string, unknown>[] = [];
  try {
    await port.runTurn({ ...input, onUpdate: async (update) => void updates.push(update) });
  } finally {
    await port.closeSession(input.sessionId);
  }
  const chunk = updates.find((update) => update.sessionUpdate === "agent_message_chunk");
  return JSON.parse((chunk?.content as { text: string }).text) as {
    argv: string[];
    execArgv: string[];
    env: Record<string, string | undefined>;
  };
}

describe("Claude Git Bash 路径", () => {
  async function gitInstall() {
    const root = await mkdtemp(join(tmpdir(), "zcode-git-bash-"));
    roots.push(root);
    await mkdir(join(root, "cmd"), { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "cmd", "git.exe"), "");
    await writeFile(join(root, "bin", "bash.exe"), "");
    return root;
  }

  // 推导使用 win32 路径语义，只能在 Windows 上对真实临时文件验证。
  test.skipIf(process.platform !== "win32")("Windows 从 PATH 上 git.exe 推导同一安装的 bin\\bash.exe，不使用 PATH 上的其他 bash", async () => {
    const root = await gitInstall();
    const wsl = await mkdtemp(join(tmpdir(), "zcode-wsl-bash-"));
    roots.push(wsl);
    await writeFile(join(wsl, "bash.exe"), "");
    const env: NodeJS.ProcessEnv = { Path: [wsl, join(root, "cmd")].join(";") };
    await ensureClaudeGitBashPath(env, "win32");
    expect(env[CLAUDE_GIT_BASH_ENV]?.toLowerCase()).toBe(join(root, "bin", "bash.exe").toLowerCase());
  });

  test("已设置、非 Windows 或找不到时不修改环境", async () => {
    const root = await gitInstall();
    const preset: NodeJS.ProcessEnv = { PATH: join(root, "cmd"), [CLAUDE_GIT_BASH_ENV]: "D:\\custom\\bash.exe" };
    await ensureClaudeGitBashPath(preset, "win32");
    expect(preset[CLAUDE_GIT_BASH_ENV]).toBe("D:\\custom\\bash.exe");
    const posix: NodeJS.ProcessEnv = { PATH: join(root, "cmd") };
    await ensureClaudeGitBashPath(posix, "darwin");
    expect(posix).not.toHaveProperty(CLAUDE_GIT_BASH_ENV);
    const missing: NodeJS.ProcessEnv = { PATH: tmpdir() };
    await ensureClaudeGitBashPath(missing, "win32");
    expect(missing).not.toHaveProperty(CLAUDE_GIT_BASH_ENV);
  });
});

describe("子智能体命名指令", () => {
  async function sessionParams(engine: "claude-code" | "codex", env: Record<string, string>) {
    const { port } = await setup(engine, { FIXTURE_MODE: "session-params", ...env });
    const input = turn(engine);
    const updates: Record<string, unknown>[] = [];
    try {
      await port.runTurn({ ...input, onUpdate: async (update) => void updates.push(update) });
    } finally {
      await port.closeSession(input.sessionId);
    }
    const chunk = updates.find((update) => update.sessionUpdate === "agent_message_chunk");
    return JSON.parse((chunk?.content as { text: string }).text) as Record<string, unknown>;
  }

  test("Claude 声明 systemPrompt 能力时以 append 追加命名指令", async () => {
    const params = await sessionParams("claude-code", { FIXTURE_SYSTEM_PROMPT_CAP: "1" });
    expect(params.systemPrompt).toEqual({
      mode: "append",
      content: [{ type: "text", text: SUBAGENT_NAMING_INSTRUCTIONS["claude-code"] }],
    });
    expect(params).not.toHaveProperty("_meta");
  });

  test("Claude 未声明 systemPrompt 能力时不发送该字段", async () => {
    const params = await sessionParams("claude-code", {});
    expect(params).not.toHaveProperty("systemPrompt");
  });

  test("Codex 新会话经 AIR customInstructions 追加命名指令", async () => {
    const params = await sessionParams("codex", {});
    expect(params._meta).toEqual({
      jetbrains: { air: { customInstructions: SUBAGENT_NAMING_INSTRUCTIONS.codex } },
    });
    expect(params).not.toHaveProperty("systemPrompt");
  });
});

describe("adapter 子进程环境", () => {
  test("沿用 CLI 恢复用户代理与证书变量；YCode 显式代理覆盖同名变量", async () => {
    const passthrough = JSON.stringify({
      HTTPS_PROXY: "http://user-proxy.example:3128",
      NO_PROXY: "localhost,.corp.example",
      NODE_EXTRA_CA_CERTS: join(tmpdir(), "corp-ca.pem"),
    });
    const user = await setup("codex", {
      FIXTURE_MODE: "report",
      [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: passthrough,
    });
    const fromUser = await reported(user.port, turn("codex"));
    expect(fromUser.env).toMatchObject({
      HTTPS_PROXY: "http://user-proxy.example:3128",
      NO_PROXY: "localhost,.corp.example",
      NODE_EXTRA_CA_CERTS: join(tmpdir(), "corp-ca.pem"),
    });
    // 夹具回报的是 adapter 进程内环境：Windows 原生官方 CLI 时预加载已移除 Node 模式变量，
    // 官方 CLI 与其命令不再继承；其他情况 adapter 仍以继承的 Node 模式运行子进程。
    const nativeOfficial = fromUser.execArgv.includes(SCRUB_ELECTRON_RUN_AS_NODE_IMPORT);
    expect(fromUser.env.ELECTRON_RUN_AS_NODE).toBe(nativeOfficial ? undefined : "1");
    expect(nativeOfficial).toBe(process.platform === "win32");
    expect(fromUser.env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeUndefined();
    const ycode = await setup("codex", {
      FIXTURE_MODE: "report",
      [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: passthrough,
      [ZCODE_HTTP_PROXY_ENV_KEY]: "http://ycode-proxy.example:7890",
    });
    const fromYcode = await reported(ycode.port, turn("codex"));
    expect(fromYcode.env.HTTPS_PROXY).toBe("http://ycode-proxy.example:7890");
    expect(fromYcode.env.HTTP_PROXY).toBe("http://ycode-proxy.example:7890");
    expect(fromYcode.env.NO_PROXY).toBe("localhost,.corp.example");
  });

  test("Claude API Key 只出现在 adapter 环境，不进入 argv 或回调", async () => {
    const key = "claude-secret-for-argv-check";
    const f = await setup("claude-code", { FIXTURE_MODE: "report" });
    await writeFile(
      join(f.root, "connections.json"),
      JSON.stringify({
        activeProfileId: "inherit",
        profiles: [
          {
            id: "gateway",
            engine: "claude-code",
            mode: "apiKey",
            credentialKey: "external-engine:claude-code:gateway",
            hasApiKey: true,
            baseUrl: "https://claude-gw.example",
          },
        ],
      }),
    );
    await createSharedZCodeCredentialStore({ env: f.env }).save(
      "external-engine:claude-code:gateway",
      key,
    );
    const onConnectionProfile = vi.fn(async () => {});
    const onSession = vi.fn(async () => {});
    const result = await reported(f.port, {
      ...turn("claude-code"),
      connectionProfileId: "gateway",
      onConnectionProfile,
      onSession,
    });
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe(key);
    expect(result.env.ANTHROPIC_BASE_URL).toBe("https://claude-gw.example");
    expect(JSON.stringify(result.argv)).not.toContain(key);
    expect(JSON.stringify([onConnectionProfile.mock.calls, onSession.mock.calls])).not.toContain(
      key,
    );
  });
});

describe("Electron Node 模式不外泄", () => {
  test("仅 Windows 原生官方 CLI 时预加载移除变量，JavaScript 入口与其他平台保持原样", () => {
    const entry = "C:\\engines\\codex@2.2.2\\dist\\index.js";
    expect(adapterLaunchArgs(entry, "C:\\bin\\codex.exe", "win32")).toEqual([
      "--import",
      SCRUB_ELECTRON_RUN_AS_NODE_IMPORT,
      entry,
    ]);
    expect(adapterLaunchArgs(entry, "C:\\bin\\claude.EXE", "win32")[0]).toBe("--import");
    // adapter 自带 codex.js 经 process.execPath 运行，依赖继承的 Node 模式。
    expect(adapterLaunchArgs(entry, "C:\\engines\\bin\\codex.js", "win32")).toEqual([entry]);
    expect(adapterLaunchArgs(entry, undefined, "win32")).toEqual([entry]);
    // POSIX 补位 node 为符号链接，依赖继承变量，本版不移除。
    expect(adapterLaunchArgs(entry, "/usr/local/bin/codex", "darwin")).toEqual([entry]);
  });

  test("预加载在入口运行前移除变量，adapter 之后创建的子进程不再继承", async () => {
    const script = [
      "const { spawnSync } = require('node:child_process');",
      "const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))'], { encoding: 'utf8' });",
      "process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE) + '|' + child.stdout);",
    ].join("\n");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", SCRUB_ELECTRON_RUN_AS_NODE_IMPORT, "-e", script],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true },
    );
    expect(stdout).toBe("undefined|undefined");
  });
});

describe("Windows 运行时补位", () => {
  test("node.cmd 内容为纯 ASCII，可执行路径经 Unicode 环境变量传入并显式进入 Node 模式", () => {
    const content = windowsNodeShimContent();
    expect(content).toBe(
      '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%ZCODE_EXTERNAL_ENGINE_NODE%" %*\r\n',
    );
    expect(/^[\x20-\x7e\r\n]*$/.test(content)).toBe(true);
  });

  test.runIf(process.platform === "win32")(
    "PATH 缺 node 时前置 node.cmd，可在含中文与空格的路径下执行当前运行时",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-node-shim-"));
      roots.push(root);
      // 模拟用户名含中文的安装路径：cmd 按代码页解码批处理，路径不能写进 node.cmd。
      const runtimeDir = join(root, "用户 张三", "YCode");
      await mkdir(runtimeDir, { recursive: true });
      const executable = join(runtimeDir, "YCode.exe");
      await link(process.execPath, executable).catch(() => copyFile(process.execPath, executable));
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const env: NodeJS.ProcessEnv = {
        Path: join(systemRoot, "System32"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: systemRoot,
        ZCODE_EXTERNAL_ENGINE_NODE: "C:\\inherited\\other.exe",
      };
      await ensureNodeRuntimeOnPath(root, executable, env, "win32");
      expect(env.ZCODE_EXTERNAL_ENGINE_NODE).toBe(executable);
      const bin = env.Path!.split(";")[0]!;
      expect(bin.startsWith(join(root, ".node-runtime"))).toBe(true);
      await access(join(bin, "node.cmd"));
      // 与 cross-spawn 一致经 cmd.exe 按 PATH/PATHEXT 解析 node，确认补位入口可执行。
      const { stdout } = await promisify(execFile)(
        join(systemRoot, "System32", "cmd.exe"),
        ["/d", "/c", "node -e process.stdout.write(process.versions.node)"],
        { env, windowsHide: true, windowsVerbatimArguments: true },
      );
      expect(stdout.trim()).toBe(process.versions.node);
      // 已补位后再次准备不会重复写入或叠加 PATH。
      await ensureNodeRuntimeOnPath(root, executable, env, "win32");
      expect(env.Path!.split(";").filter((entry) => entry === bin)).toHaveLength(1);
    },
  );
});

describe("原生配置目录归一", () => {
  test.each([false, true])("脱敏真实 Codex 目录通过%s恢复握手，effort 原始档位完整保留", async (resume) => {
    const f = await setup("codex", {
      FIXTURE_MODE: "native-catalog",
      FIXTURE_CONFIG_OPTIONS: JSON.stringify(nativeCatalog.configOptions),
    });
    const input = turn("codex");
    const onConfigOptions = vi.fn(async () => {});
    try {
      await f.port.prepareSession({
        ...input,
        ...(resume ? { externalSessionId: "native-session" } : {}),
        onConfigOptions,
      });
      expect(onConfigOptions).toHaveBeenLastCalledWith(nativeCatalog.configOptions);
      expect(nativeCatalog.configOptions.find(({ id }) => id === "reasoning_effort")?.options.map(({ value }) => value))
        .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    } finally {
      await f.port.closeSession(input.sessionId);
    }
  });

  test.each([false, true])("new/resume=%s 先通知后旧响应不丢 effort，其他 session 的通知不清空目录", async (resume) => {
    const f = await setup("codex", {
      FIXTURE_MODE: "native-catalog-notification-first",
      FIXTURE_CONFIG_OPTIONS: JSON.stringify(nativeCatalog.configOptions),
    });
    const input = turn("codex");
    const onConfigOptions = vi.fn(async () => {});
    try {
      await f.port.prepareSession({
        ...input,
        ...(resume ? { externalSessionId: "native-session" } : {}),
        onConfigOptions,
      });
      expect(onConfigOptions).toHaveBeenCalledExactlyOnceWith(nativeCatalog.configOptions);
    } finally {
      await f.port.closeSession(input.sessionId);
    }
  });

  test("Codex 模型选项值的 description 为 null 时握手成功并视同缺省（本机 Windows 实测形状）", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "null-description" });
    const received: unknown[] = [];
    const input = turn("codex");
    try {
      await f.port.prepareSession({
        ...input,
        onConfigOptions: async (options) => void received.push(options),
      });
    } finally {
      await f.port.closeSession(input.sessionId);
    }
    expect(received.at(-1)).toEqual([
      {
        id: "model",
        name: "Model",
        currentValue: "gw-model",
        options: [
          { value: "gw-model", name: "6.1 Sol" },
          { value: "gpt-5.5", name: "5.5", description: "Frontier model" },
        ],
      },
    ]);
  });
});

describe("轮次 usage", () => {
  test("Codex usage 的 thoughtTokens 保留为 reasoningTokens（W7 输出提示「含思考」）", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "usage" });
    const input = turn("codex");
    try {
      const result = await f.port.runTurn(input);
      expect(result?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 1234,
        cachedReadTokens: 4,
        cachedWriteTokens: 0,
        reasoningTokens: 300,
      });
    } finally {
      await f.port.closeSession(input.sessionId);
    }
  });
});

describe("测试连接", () => {
  test("沿用正式 ACP 启动路径完成最小请求，结束后删除临时 cwd", async () => {
    const f = await setup("claude-code");
    const cwdFile = join(f.root, "fixture-cwd.txt");
    const port = createExternalEnginePort({
      env: { ...f.env, FIXTURE_CWD_FILE: cwdFile },
      executable: process.execPath,
    });
    const result = await runExternalEngineConnectionTest(port, {
      engine: "claude-code",
      connectionProfileId: "official",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "success" });
    const cwd = await readFile(cwdFile, "utf8");
    expect(cwd).toContain("ycode-engine-test-");
    await expect(access(cwd)).rejects.toThrow();
  });

  test.each([
    ["codex-error", "authentication", 401],
    ["air-error", "authentication", undefined],
    ["rpc-error", "provider", 503],
  ] as const)("%s 以终态 error 映射为结构化失败", async (mode, code, httpStatus) => {
    const f = await setup("codex", { FIXTURE_MODE: mode });
    const result = await runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", failure: { code } });
    if (result.status !== "failed") throw new Error("unexpected result");
    expect(result.failure.httpStatus).toBe(httpStatus);
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnop");
    if (mode === "codex-error") expect(result.failure.requestId).toBe("req_123");
  });

  // 修复回归（反馈 7）：Codex 把非致命 WarningEvent 作为 typed failure（warning）上报，旧规则见到
  // 首个失败即判失败；现在只以 error 判失败，收到 OK 即通过并附带脱敏后的警告。
  test("typed warning 后收到 OK → 通过并带 warnings", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "typed-warning-ok" });
    const result = await runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "success",
      warnings: [{ message: expect.stringContaining("Model metadata for gw-model not found") }],
    });
  });

  test("ACP notice 后收到 OK → 通过，warning 级 notice 脱敏去重后进入 warnings，info 不进入", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "notice-ok" });
    const result = await runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unexpected result");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]?.message).toContain("Model metadata not found");
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnop");
    expect(JSON.stringify(result)).not.toContain("Model rerouted");
  });

  test("会话中 notice 只经 onNotice 交付（脱敏），不进入 onUpdate 或 onFailure", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "notice-ok" });
    const updates: Record<string, unknown>[] = [];
    const notices: unknown[] = [];
    const onFailure = vi.fn(async () => {});
    const input = turn("codex", updates);
    try {
      await f.port.runTurn({
        ...input,
        onFailure,
        onNotice: async (notice) => void notices.push(notice),
      });
    } finally {
      await f.port.closeSession(input.sessionId);
    }
    expect(updates.some((update) => update.sessionUpdate === "notice")).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    expect(notices).toEqual([
      { severity: "warning", message: "Model metadata not found — token [REDACTED] leaked" },
      { severity: "warning", message: "Model metadata not found — token [REDACTED] leaked" },
      { severity: "info", message: "Model rerouted" },
    ]);
  });

  test("没有警告时成功结果不带 warnings 字段", async () => {
    const f = await setup("codex");
    const result = await runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("success");
    expect(result).not.toHaveProperty("warnings");
  });

  test("以正文返回的错误显示脱敏摘要，不当成成功", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "text-error" });
    const result = await runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("unexpectedReply");
    const text = JSON.stringify(result);
    // 1.1 方案统一脱敏口径：URL 只保留 scheme + host + path（与行内错误行一致），query 与凭据剔除。
    expect(text).not.toMatch(/leak|sk-abcdefghijklmnop|\?key=/);
    expect(text).toContain("https://gw.example/v1");
  });

  test("取消后返回 cancelled 并关闭原生会话", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "hang" });
    const controller = new AbortController();
    const pending = runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    expect(await pending).toEqual({ status: "cancelled" });
  });

  test("连接配置不可用时返回配置失败，仍执行清理", async () => {
    const closeSession = vi.fn(async () => {});
    const port = {
      prepareSession: async () => {},
      runTurn: async () => {
        throw new ExternalEngineConnectionError({ code: "configuration" });
      },
      setConfigOption: async () => [],
      closeSession,
    } satisfies ExternalEnginePort;
    const result = await runExternalEngineConnectionTest(port, {
      engine: "claude-code",
      connectionProfileId: "missing",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", failure: { code: "configuration" } });
    expect(closeSession).toHaveBeenCalledOnce();
  });
});
