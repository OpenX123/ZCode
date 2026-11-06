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
  ensureNodeRuntimeOnPath,
  windowsNodeShimContent,
} from "../src/external-engine/adapter-env.js";
import {
  createExternalEnginePort,
  runExternalEngineConnectionTest,
} from "../src/external-engine/index.js";

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
if (process.env.FIXTURE_CWD_FILE) fs.writeFileSync(process.env.FIXTURE_CWD_FILE, process.cwd());
let prompt;
const text = (value) => send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } });
const info = (meta) => send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "session_info_update", _meta: meta } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1 } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: sid } });
  else if (message.method === "session/cancel") send({ id: prompt.id, result: { stopReason: "cancelled" } });
  else if (message.method === "session/prompt") {
    prompt = message;
    const env = {};
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ELECTRON_RUN_AS_NODE", "ZCODE_TOOL_ENV_PASSTHROUGH_JSON"]) env[key] = process.env[key];
    if (mode === "report") { text(JSON.stringify({ argv: process.argv.slice(1), env })); send({ id: message.id, result: { stopReason: "end_turn" } }); }
    else if (mode === "codex-error") info({ codex: { error: { message: "unexpected status 401 Unauthorized: bad key sk-abcdefghijklmnop request id: req_123", httpStatus: 401, willRetry: true } } });
    else if (mode === "air-error") info({ jetbrains: { air: { sessionFailure: { id: "f1", severity: "error", category: "access", title: "Sign in to continue using Claude." } } } });
    else if (mode === "rpc-error") send({ id: message.id, error: { code: -32603, message: "Internal error", data: { message: "upstream 503 Service Unavailable", httpStatus: 503 } } });
    else if (mode === "text-error") { text("unexpected status 401 Unauthorized at https://gw.example/v1?key=leak token sk-abcdefghijklmnop"); send({ id: message.id, result: { stopReason: "end_turn" } }); }
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
    env: Record<string, string | undefined>;
  };
}

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
      ELECTRON_RUN_AS_NODE: "1",
    });
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
  ] as const)("%s 映射为结构化失败，不等待引擎重试", async (mode, code, httpStatus) => {
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

  test("以正文返回的错误显示脱敏摘要，不当成成功", async () => {
    const f = await setup("codex", { FIXTURE_MODE: "text-error" });
    const result = await runExternalEngineConnectionTest(f.port, {
      engine: "codex",
      connectionProfileId: "inherit",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("unexpectedReply");
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/leak|sk-abcdefghijklmnop|gw\.example/);
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
