import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
async function setup(supported: boolean) {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-fork-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptor = EXTERNAL_ENGINE_RUNTIMES.codex;
  const entry = join(
    root,
    managedAdapterInstallDirName(descriptor),
    ...managedAdapterEntrySegments(descriptor),
  );
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(
    entry,
    String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);if(!f.method)return;
 fs.appendFileSync(path.join(process.env.HOME,'calls.jsonl'),JSON.stringify({method:f.method,params:f.params,home:process.env.CODEX_HOME})+'\n');
 if(f.method==='initialize')send({id:f.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:${supported ? "{fork:{},resume:{}}" : "{}"}}}});
 else if(f.method==='session/fork'){
  send({method:'session/update',params:{sessionId:'native-child',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'parent-history'}}}});
  send({method:'session/update',params:{sessionId:'native-child',update:{sessionUpdate:'session_info_update',title:'Forked title',_meta:{codex:{error:{message:'old gateway error',willRetry:true}}}}}});
  send({id:77,method:'session/request_permission',params:{sessionId:'native-child',toolCall:{toolCallId:'parent-pending'},options:[]}});
  send({id:f.id,result:{sessionId:'native-child',configOptions:[]}});
 }else if(f.method==='session/resume')send({id:f.id,result:{sessionId:f.params.sessionId,configOptions:[]}});
 else if(f.method==='session/prompt')send({id:f.id,result:{stopReason:'end_turn'}});
});`,
  );
  await writeFile(
    join(root, "connections.json"),
    JSON.stringify({
      activeProfileId: "another-default",
      profiles: [
        { id: "inherit", mode: "inherit" },
        { id: "parent-profile", mode: "official" },
        { id: "another-default", mode: "official" },
      ],
    }),
  );
  const port = createExternalEnginePort({
    env: {
      ...process.env,
      [EXTERNAL_ENGINES_DIR_ENV]: root,
      [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
    },
    executable: process.execPath,
  });
  cleanups.push(() => port.closeSession("local-child"));
  const onSession = vi.fn(async () => {});
  const onUpdate = vi.fn(async () => {});
  const requestPermission = vi.fn(async () => ({ outcome: "cancelled" as const }));
  const input: ExternalEngineSessionInput & { parentExternalSessionId: string } = {
    sessionId: "local-child",
    engine: "codex",
    connectionProfileId: "parent-profile",
    parentExternalSessionId: "native-parent",
    cwd: root,
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    onSession,
    onUpdate,
    onConfigOptions: async () => {},
    requestPermission,
  };
  const calls = async () =>
    (await readFile(join(root, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, port, input, calls, onSession, onUpdate, requestPermission };
}

test("原生 fork 沿用源身份与目标cwd，不提交prompt或重放父历史/权限，冷恢复仍是child", async () => {
  const f = await setup(true);
  expect(await f.port.forkSession!(f.input)).toBe("native-child");
  expect(f.onSession).toHaveBeenCalledWith("native-child");
  expect((await f.calls()).map((item) => item.method)).toEqual(["initialize", "session/fork"]);
  expect((await f.calls())[1]).toMatchObject({
    params: { sessionId: "native-parent", cwd: f.root },
    home: join(f.root, "connections", "parent-profile", "codex-home"),
  });
  expect(f.onUpdate).toHaveBeenCalledExactlyOnceWith({
    sessionUpdate: "session_info_update",
    title: "Forked title",
  });
  expect(f.requestPermission).not.toHaveBeenCalled();
  await f.port.closeSession(f.input.sessionId);
  await f.port.prepareSession({ ...f.input, externalSessionId: "native-child" });
  const calls = await f.calls();
  expect(calls.map((item) => item.method)).toEqual([
    "initialize",
    "session/fork",
    "initialize",
    "session/resume",
  ]);
  expect(calls[3].params.sessionId).toBe("native-child");
});

test("引擎未声明原生fork时返回typed unsupported，调用方可显式交接上下文", async () => {
  const f = await setup(false);
  await expect(f.port.forkSession!(f.input)).rejects.toMatchObject({
    failure: { code: "unsupported", method: "session/fork" },
  });
  expect((await f.calls()).map((item) => item.method)).toEqual(["initialize"]);
});
