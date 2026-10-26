import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRootTraceContext, type ExternalEngineSessionInput } from "@zcode/contracts";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import { createExternalEnginePort } from "../src/external-engine/index.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(engine: "claude-code" | "codex", fixture: string) {
  const root = await mkdtemp(join(tmpdir(), "zcode-acp-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
  const entry = join(
    root,
    managedAdapterInstallDirName(descriptor),
    ...managedAdapterEntrySegments(descriptor),
  );
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, fixture);
  const env = {
    ...process.env,
    [EXTERNAL_ENGINES_DIR_ENV]: root,
    [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
  };
  const port = createExternalEnginePort({
    env,
    executable: process.execPath,
  });
  cleanups.push(() => port.closeSession("local-session"));
  return { port, root, env };
}
function turn(
  engine: "claude-code" | "codex",
  updates: Record<string, unknown>[],
  _sessions: string[],
): ExternalEngineSessionInput & { prompt: Array<{ type: "text"; text: string }> } {
  return {
    sessionId: "local-session",
    engine,
    cwd: tmpdir(),
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    prompt: [{ type: "text", text: "example" }],
    async onSession() {},
    async onConfigOptions() {},
    async onUpdate(update) {
      updates.push(update);
    },
    async requestPermission() {
      return { outcome: "cancelled" };
    },
  };
}
// 真实 stdio 与磁盘计数跨进程保留，验证重试边界而非模拟内部实现。
function recoveryFixture(settings: {
  failMethod?: string;
  code?: number;
  failures?: number;
  loadOnly?: boolean;
  resumeUnsupported?: boolean;
  exitMethod?: string;
  mode?: string;
  supportsAuto?: boolean;
  autoFallback?: string;
}) {
  return String.raw`
const fs=require('node:fs'), path=require('node:path'), readline=require('node:readline');
const settings=${JSON.stringify(settings)}, log=path.join(process.env.HOME,'calls.jsonl');
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
const options=[{id:'mode',name:'Mode',currentValue:settings.mode??'safe',options:settings.mode?[{value:'default',name:'Manual'},{value:'plan',name:'Plan'},{value:'acceptEdits',name:'Accept edits'},...(settings.supportsAuto?[{value:'auto',name:'Auto'}]:[])]:[{value:'safe',name:'Safe'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line); if(!f.method)return;
 fs.appendFileSync(log,JSON.stringify({method:f.method,sessionId:f.params?.sessionId,configId:f.params?.configId,value:f.params?.value})+'\n');
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));
 if(f.method===settings.exitMethod){process.exit(7);}
 if(f.method===settings.failMethod && calls.filter(x=>x.method===f.method).length<=(settings.failures??99)){
  send({id:f.id,error:{code:settings.code,message:'test-private-token-must-not-leak',data:{private:'test-private-account'}}});return;
 }
 if(f.method==='initialize')send({id:f.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:settings.loadOnly?{}:{resume:{}}}}});
 else if(f.method==='session/resume' && settings.resumeUnsupported)send({id:f.id,error:{code:-32601,message:'unsupported'}});
 else if(f.method==='session/new'||f.method==='session/resume'||f.method==='session/load'){
  if(f.method==='session/load')for(const update of [{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old-history'}},{sessionUpdate:'tool_call',toolCallId:'old-tool',status:'completed'},{sessionUpdate:'available_commands_update',availableCommands:[]}])send({method:'session/update',params:{sessionId:'external-session',update}});
  send({id:f.id,result:{sessionId:'external-session',configOptions:options}});
 }else if(f.method==='session/set_config_option'){
  options[0].currentValue=f.params.value==='auto'?(settings.autoFallback??'auto'):f.params.value;
  send({method:'session/update',params:{sessionId:'external-session',update:{sessionUpdate:'config_option_update',configOptions:options}}});
  send({id:f.id,result:{configOptions:options}});
 }else if(f.method==='session/prompt')send({id:f.id,result:{stopReason:'end_turn'}});
});`;
}
async function recoveryCalls(root: string): Promise<Array<{ method: string; sessionId?: string }>> {
  return (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("Claude 新会话权限模式", () => {
  test("新建默认 Manual 时先确认原生 Auto 再发布，准备过程不发送 prompt", async () => {
    const { port, root } = await setup(
      "claude-code",
      recoveryFixture({ mode: "default", supportsAuto: true }),
    );
    const onConfigOptions = vi.fn(async () => {});
    const input = { ...turn("claude-code", [], []), onConfigOptions };
    await port.prepareSession(input);
    expect(onConfigOptions).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "mode", currentValue: "auto" }),
    ]);
    const calls = await recoveryCalls(root);
    expect(calls.map(({ method }) => method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
    ]);
    expect(calls[2]).toMatchObject({ configId: "mode", value: "auto" });
    await port.runTurn(input);
    expect((await recoveryCalls(root)).map(({ method }) => method)).toEqual([
      ...calls.map(({ method }) => method),
      "session/prompt",
    ]);
  });

  test.each([
    { engine: "codex", mode: "default", supportsAuto: true },
    { engine: "claude-code", mode: "default", supportsAuto: false },
    { engine: "claude-code", mode: "plan", supportsAuto: true },
    { engine: "claude-code", mode: "auto", supportsAuto: true },
    { engine: "claude-code", mode: "default", supportsAuto: true, restored: true },
    { engine: "claude-code", mode: "default", supportsAuto: true, saved: true },
  ] as const)("保留原生/已有选择：%j", async (scenario) => {
    const { port, root } = await setup(scenario.engine, recoveryFixture(scenario));
    const onConfigOptions = vi.fn(async () => {});
    await port.prepareSession({
      ...turn(scenario.engine, [], []),
      onConfigOptions,
      ...("restored" in scenario ? { externalSessionId: "external-session" } : {}),
      ...("saved" in scenario ? { configValues: [{ id: "mode", value: "default" }] } : {}),
    });
    expect(onConfigOptions).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "mode", currentValue: scenario.mode }),
    ]);
    expect(
      (await recoveryCalls(root)).some(({ method }) => method === "session/set_config_option"),
    ).toBe(false);
  });

  test("Auto 受模型限制时发布原生实际确认的模式", async () => {
    const { port } = await setup(
      "claude-code",
      recoveryFixture({ mode: "default", supportsAuto: true, autoFallback: "acceptEdits" }),
    );
    const onConfigOptions = vi.fn(async () => {});
    await port.prepareSession({ ...turn("claude-code", [], []), onConfigOptions });
    expect(onConfigOptions).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "mode", currentValue: "acceptEdits" }),
    ]);
  });
});

describe("连接恢复的重试与协议边界", () => {
  test.skipIf(process.platform === "win32")(
    "桌面 PATH 缺 node 时仍可启动 npm 官方 CLI",
    async () => {
      const fixture = recoveryFixture({}).replace(
        "if(f.method==='initialize')send",
        "if(f.method==='initialize' && require('node:child_process').spawnSync(process.env.CODEX_PATH,['--version']).status!==0){send({id:f.id,error:{code:1001,message:'CLI startup failed'}});return;} if(f.method==='initialize')send",
      );
      const { port, root, env } = await setup("codex", fixture);
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "codex"),
        '#!/usr/bin/env node\nprocess.stdout.write("codex-cli 1.0.0\\n");',
        { mode: 0o755 },
      );
      env.PATH = bin;
      await port.prepareSession({
        ...turn("codex", [], []),
        externalSessionId: "external-session",
      });
      expect(
        (await recoveryCalls(root)).filter((call) => call.method === "initialize"),
      ).toHaveLength(1);
      expect(env.PATH).toBe(bin);
    },
  );
  test.each(["claude-code", "codex"] as const)(
    "%s 暂时初始化失败后自动恢复，同会话并发准备共用三次尝试",
    async (engine) => {
      const { port, root } = await setup(
        engine,
        recoveryFixture({ failMethod: "initialize", code: -32603, failures: 2 }),
      );
      const input = { ...turn(engine, [], []), externalSessionId: "external-session" };
      await Promise.all([port.prepareSession(input), port.prepareSession(input)]);
      const calls = await recoveryCalls(root);
      expect(calls.filter((call) => call.method === "initialize")).toHaveLength(3);
      expect(calls.filter((call) => call.method === "session/resume")).toEqual([
        { method: "session/resume", sessionId: "external-session" },
      ]);
      expect(calls.some((call) => call.method === "session/prompt")).toBe(false);
    },
  );
  test.each([-32000, -32002, -32602])("RPC %s 不重试且保留安全错误码与方法", async (code) => {
    const { port, root } = await setup(
      "codex",
      recoveryFixture({ failMethod: "session/resume", code }),
    );
    const error = await port
      .prepareSession({ ...turn("codex", [], []), externalSessionId: "external-session" })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      failure: { method: "session/resume", rpcCode: code },
    });
    expect(String(error)).not.toContain("test-private");
    expect(
      (await recoveryCalls(root)).filter((call) => call.method === "session/resume"),
    ).toHaveLength(1);
  });
  test("暂时错误耗尽三次后停止，并保留最后错误", async () => {
    const { port, root } = await setup(
      "codex",
      recoveryFixture({ failMethod: "session/resume", code: -32603 }),
    );
    await expect(
      port.prepareSession({ ...turn("codex", [], []), externalSessionId: "external-session" }),
    ).rejects.toMatchObject({
      failure: { code: "request", method: "session/resume", rpcCode: -32603 },
    });
    expect(
      (await recoveryCalls(root)).filter((call) => call.method === "session/resume"),
    ).toHaveLength(3);
  });
  test("session/new 未确认 id 时不重发，prompt 已提交后也不重发", async () => {
    for (const method of ["session/new", "session/prompt"]) {
      const { port, root } = await setup(
        "codex",
        recoveryFixture({ failMethod: method, code: -32603 }),
      );
      const input = turn("codex", [], []);
      await expect(
        method === "session/new" ? port.prepareSession(input) : port.runTurn(input),
      ).rejects.toThrow();
      expect((await recoveryCalls(root)).filter((call) => call.method === method)).toHaveLength(1);
    }
  });
  test("关闭会话中止退避，迟到准备不会重建连接", async () => {
    const { port, root } = await setup(
      "codex",
      recoveryFixture({ failMethod: "initialize", code: -32603 }),
    );
    const completion = port.prepareSession(turn("codex", [], [])).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await recoveryCalls(root)).toHaveLength(1));
    await port.closeSession("local-session");
    expect(await completion).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await recoveryCalls(root)).toHaveLength(1);
  });
  test("路径探测尚未完成时关闭会话，不启动迟到的子进程", async () => {
    const { port, root } = await setup("codex", recoveryFixture({}));
    const completion = port.prepareSession(turn("codex", [], [])).catch((error: unknown) => error);
    await port.closeSession("local-session");
    expect(await completion).toBeInstanceOf(Error);
    await expect(readFile(join(root, "calls.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  test.each([false, true])(
    "协商 load（resume 不支持=%s）恢复原 id，不重复交付历史正文与工具",
    async (resumeUnsupported) => {
      const { port, root } = await setup(
        "codex",
        recoveryFixture({ loadOnly: !resumeUnsupported, resumeUnsupported }),
      );
      const updates: Record<string, unknown>[] = [];
      await port.prepareSession({
        ...turn("codex", updates, []),
        externalSessionId: "external-session",
      });
      const calls = await recoveryCalls(root);
      expect(calls.find((call) => call.method === "session/load")?.sessionId).toBe(
        "external-session",
      );
      expect(calls.some((call) => call.method === "session/new")).toBe(false);
      expect(updates.map((update) => update.sessionUpdate)).toEqual(["available_commands_update"]);
    },
  );
});

test("session/new 已发出而进程退出时，不自动制造第二个未知会话", async () => {
  const { port, root } = await setup("codex", recoveryFixture({ exitMethod: "session/new" }));
  await expect(port.prepareSession(turn("codex", [], []))).rejects.toMatchObject({
    failure: { code: "transport", method: "session/new" },
  });
  expect((await recoveryCalls(root)).filter((call) => call.method === "session/new")).toHaveLength(
    1,
  );
});
