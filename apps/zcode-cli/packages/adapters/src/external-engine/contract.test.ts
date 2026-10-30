import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootTraceContext, type ExternalEngineTurnInput } from "@zcode/contracts";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import { createExternalEnginePort } from "./index.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const script = `const readline=require('node:readline'); const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n'); let prompt; const sid='external-session'; readline.createInterface({input:process.stdin}).on('line',(line)=>{const x=JSON.parse(line); const result=(value)=>send({id:x.id,result:value}); if(x.method==='initialize')result({protocolVersion:1}); else if(x.method==='session/new'||x.method==='session/resume'){ send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'compact',description:'compact'}]}}}); result({sessionId:sid,configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:'safe',options:[{value:'safe',name:'Safe'}]}]}); } else if(x.method==='session/prompt'){if(x.params.prompt[0].text==='exit'){process.exit(7);}if(x.params.prompt[0].text==='malformed'){process.stdout.write('invalid-test-private-frame\\n');return;}if(x.params.prompt[0].text==='env-check'){send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({nodeMode:process.env.ELECTRON_RUN_AS_NODE,home:process.env.HOME,profile:process.env.USERPROFILE,anthropicRemoved:!process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN&&!process.env.ANTHROPIC_BASE_URL})}}}});result({stopReason:'end_turn'});return;}prompt=x; send({id:900,method:'session/request_permission',params:{sessionId:sid,toolCall:{toolCallId:'tool-id',title:'Write'},options:[{optionId:'unique-deny',kind:'reject_once',name:'Deny'},{optionId:'unique-allow',kind:'allow_once',name:'Allow'}]}});} else if(x.id===900){send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:x.result.outcome.optionId}}}}); send({id:prompt.id,result:{stopReason:'end_turn',usage:{inputTokens:5,outputTokens:2}}});} else if(x.method==='session/cancel')send({id:prompt.id,result:{stopReason:'cancelled'}}); else if(x.method==='session/set_config_option' && x.params.value==='reject')send({id:x.id,error:{code:-32602,message:'unsupported while running'}}); else if(x.method==='session/set_config_option')result({configOptions:[{id:'mode',name:'Mode',currentValue:x.params.value,options:[{value:'safe',name:'Safe'}]}]});});`;
async function setup(engine: "claude-code" | "codex") {
  const root = await mkdtemp(join(tmpdir(), "zcode-acp-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
  const entry = join(
    root,
    managedAdapterInstallDirName(descriptor),
    ...managedAdapterEntrySegments(descriptor),
  );
  await mkdir(join(entry, ".."), { recursive: true });
  await writeFile(entry, script);
  const port = createExternalEnginePort({
    env: {
      ...process.env,
      [EXTERNAL_ENGINES_DIR_ENV]: root,
      [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
      ANTHROPIC_API_KEY: "test-only-secret",
      ANTHROPIC_AUTH_TOKEN: "test-only-secret",
      ANTHROPIC_BASE_URL: "https://example.invalid",
    },
    executable: process.execPath,
  });
  cleanups.push(() => port.closeSession("local-session"));
  return { port, root };
}
function turn(
  engine: "claude-code" | "codex",
  updates: Record<string, unknown>[],
  sessions: string[],
): ExternalEngineTurnInput {
  return {
    sessionId: "local-session",
    engine,
    cwd: tmpdir(),
    prompt: [{ type: "text", text: "example" }],
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    async onSession(id) {
      sessions.push(id);
    },
    async onConfigOptions() {},
    async onUpdate(update) {
      updates.push(update);
    },
    async requestPermission() {
      return { outcome: "selected", optionId: "unique-deny" };
    },
  };
}
describe("官方 ACP adapter 双向会话", () => {
  test.each(["claude-code", "codex"] as const)(
    "%s 保留首次响应前的命令帧，按原权限id返回并复用会话",
    async (engine) => {
      const { port } = await setup(engine);
      const updates: Record<string, unknown>[] = [];
      const sessions: string[] = [];
      const result = await port.runTurn(turn(engine, updates, sessions));
      expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
      expect(updates.map((update) => update.sessionUpdate)).toEqual([
        "available_commands_update",
        "agent_message_chunk",
      ]);
      expect(updates[1]?.content).toMatchObject({ text: "unique-deny" });
      expect(sessions).toEqual(["external-session"]);
      await port.runTurn(turn(engine, updates, sessions));
      expect(sessions).toHaveLength(1);
      expect(await port.setConfigOption("local-session", "mode", "safe")).toMatchObject([
        { id: "mode", currentValue: "safe" },
      ]);
      await port.closeSession("local-session");
      await port.runTurn({
        ...turn(engine, updates, sessions),
        externalSessionId: "external-session",
      });
      expect(sessions).toHaveLength(2);
    },
  );
  test("冷恢复不接受原生会话替换或失效配置，失败后可以重新连接原会话", async () => {
    const { port } = await setup("codex");
    const input = { ...turn("codex", [], []), externalSessionId: "different-session" };
    await expect(port.prepareSession(input)).rejects.toThrow("different session");
    await expect(
      port.prepareSession({
        ...input,
        externalSessionId: "external-session",
        configValues: [{ id: "mode", value: "removed" }],
      }),
    ).rejects.toThrow("unavailable");
    const onConfigOptions = vi.fn(async () => {});
    await port.prepareSession({
      ...input,
      externalSessionId: "external-session",
      configValues: [{ id: "mode", value: "safe" }],
      onConfigOptions,
    });
    expect(onConfigOptions).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "mode", currentValue: "safe" })]),
    );
  });
  test("未安装或用户 HOME 非绝对路径时明确拒绝且不启动", async () => {
    const port = createExternalEnginePort({
      env: { [EXTERNAL_ENGINES_DIR_ENV]: tmpdir(), [EXTERNAL_ENGINE_USER_HOME_ENV]: "relative" },
    });
    await expect(port.runTurn(turn("codex", [], []))).rejects.toMatchObject({
      code: "engine_not_ready",
    });
  });
  test.each(["claude-code", "codex"] as const)(
    "%s 取消时接受原生空 usage 并保留可续用的进程",
    async (engine) => {
      const { port, root } = await setup(engine);
      const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
      await writeFile(
        join(
          root,
          managedAdapterInstallDirName(descriptor),
          ...managedAdapterEntrySegments(descriptor),
        ),
        script.replace("stopReason:'cancelled'", "stopReason:'cancelled',usage:null"),
      );
      const abort = new AbortController();
      const value = turn(engine, [], []);
      value.signal = abort.signal;
      value.requestPermission = async () => {
        abort.abort();
        return { outcome: "cancelled" };
      };
      expect((await port.runTurn(value)).stopReason).toBe("cancelled");
      expect(await port.setConfigOption(value.sessionId, "mode", "safe")).toHaveLength(1);
      expect((await port.runTurn(turn(engine, [], []))).stopReason).toBe("end_turn");
    },
  );
});

test("进程异常退出与非法帧拒绝pending，不泄露帧且可恢复新进程", async () => {
  const { port } = await setup("codex");
  for (const text of ["exit", "malformed"]) {
    const input = turn("codex", [], []);
    input.prompt = [{ type: "text", text }];
    await expect(port.runTurn(input)).rejects.toThrow(
      text === "exit" ? "ACP adapter exited (code 7)" : "Invalid ACP frame",
    );
  }
  expect((await port.runTurn(turn("codex", [], []))).stopReason).toBe("end_turn");
});
test("外部Claude恢复真实HOME/USERPROFILE并清除API环境变量", async () => {
  const { port, root } = await setup("claude-code");
  const updates: Record<string, unknown>[] = [];
  const input = turn("claude-code", updates, []);
  input.prompt = [{ type: "text", text: "env-check" }];
  await port.runTurn(input);
  const content = updates.find((update) => update.sessionUpdate === "agent_message_chunk")
    ?.content as { text: string };
  expect(JSON.parse(content.text)).toEqual({
    nodeMode: "1",
    home: root,
    profile: root,
    anthropicRemoved: true,
  });
});

test.each(["claude-code", "codex"] as const)(
  "%s 首发前初始化并切换配置，不提交prompt且首发复用连接",
  async (engine) => {
    const { port } = await setup(engine);
    const updates: Record<string, unknown>[] = [];
    const sessions: string[] = [];
    const input = turn(engine, updates, sessions);
    input.onConfigOptions = vi.fn();
    await port.prepareSession(input);
    expect(input.onConfigOptions).toHaveBeenCalledWith([expect.objectContaining({ id: "mode" })]);
    expect(updates.map((update) => update.sessionUpdate)).toEqual(["available_commands_update"]);
    await port.setConfigOption(input.sessionId, "mode", "safe");
    await port.runTurn(input);
    expect(sessions).toEqual(["external-session"]);
    expect(updates.some((update) => update.sessionUpdate === "agent_message_chunk")).toBe(true);
  },
);

test.each(["claude-code", "codex"] as const)(
  "%s 运行中配置成功或业务拒绝都不打断原 prompt",
  async (engine) => {
    const { port } = await setup(engine);
    let releasePermission!: () => void;
    let permissionStarted!: () => void;
    const permissionReady = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    const input = turn(engine, [], []);
    input.requestPermission = async () => {
      permissionStarted();
      await permissionGate;
      return { outcome: "selected", optionId: "unique-allow" };
    };
    const completion = port.runTurn(input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await permissionReady;
      expect(await port.setConfigOption(input.sessionId, "mode", "safe")).toMatchObject([
        { id: "mode", currentValue: "safe" },
      ]);
      await expect(port.setConfigOption(input.sessionId, "mode", "reject")).rejects.toThrow(
        "External engine request failed",
      );
    } finally {
      releasePermission();
    }
    expect(await completion).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(await port.setConfigOption(input.sessionId, "mode", "safe")).toHaveLength(1);
  },
);
