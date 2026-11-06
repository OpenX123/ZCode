import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRootTraceContext,
  type ExternalEngineFailureNotice,
  type ExternalEngineSessionInput,
} from "@zcode/contracts";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import { createExternalEnginePort } from "../src/external-engine/index.js";

// 帧形状取自本机 codex-acp 2.2.2（CodexEventHandler.createErrorEvent / terminalFailurePromptResponse）
// 与 claude-agent-acp 0.95.0（internalErrorForClient）；密钥、网关与请求 ID 均为夹具值。
const ADAPTER = String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
const update=u=>send({method:'session/update',params:{sessionId:'native-1',update:u}});
const details='unexpected status 502 Bad Gateway: Bad gateway, url: https://gateway.example.test/v1/responses?api_key=fixture-secret, request id: fixture-request';
const failure=(revision,severity,title)=>({jetbrains:{air:{version:1,sessionFailure:{id:'codex-turn-1:error',revision,category:'connection',severity,title,actions:severity==='error'?['retry','new_session']:[]}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);if(!f.method)return;
 fs.appendFileSync(path.join(process.env.HOME,'calls.jsonl'),JSON.stringify({method:f.method,params:f.params})+'\n');
 if(f.method==='initialize')send({id:f.id,result:{protocolVersion:1,agentCapabilities:{}}});
 else if(f.method==='session/new')send({id:f.id,result:{sessionId:'native-1',configOptions:[]}});
 else if(f.method==='session/prompt'){
  const text=f.params.prompt[0].text;
  if(text==='TYPED_RETRY_THEN_FAIL'){
   update({sessionUpdate:'session_info_update',_meta:failure(1,'warning','Reconnecting... 1/5')});
   update({sessionUpdate:'session_info_update',_meta:failure(2,'warning','Reconnecting... 2/5')});
   send({id:f.id,result:{stopReason:'end_turn',usage:null,_meta:{quota:{token_count:null,model_usage:[]},...failure(3,'error',details)}}});
  }else if(text==='LEGACY_RETRY'){
   update({sessionUpdate:'session_info_update',_meta:{codex:{error:{message:'Reconnecting... 2/5',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:502}},additionalDetails:details,turnId:'codex-turn-2',willRetry:true}}}});
   update({sessionUpdate:'agent_message_chunk',messageId:'item-1',content:{type:'text',text:'recovered'}});
   send({id:f.id,result:{stopReason:'end_turn',usage:null}});
  }else if(text==='CLAUDE_502'){
   send({id:f.id,error:{code:-32603,message:'Internal error: API Error: 502 {"type":"error","error":{"type":"api_error","message":"Bad Gateway"},"request_id":"req_fixture01"}',data:{errorKind:'server_error'}}});
  }
 }
});`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(engine: "claude-code" | "codex") {
  const root = await mkdtemp(join(tmpdir(), "zcode-acp-failures-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
  const entry = join(
    root,
    managedAdapterInstallDirName(descriptor),
    ...managedAdapterEntrySegments(descriptor),
  );
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, ADAPTER);
  const port = createExternalEnginePort({
    env: {
      ...process.env,
      [EXTERNAL_ENGINES_DIR_ENV]: root,
      [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
    },
    executable: process.execPath,
  });
  cleanups.push(() => port.closeSession("local-session"));
  const notices: ExternalEngineFailureNotice[] = [];
  const updates: Record<string, unknown>[] = [];
  const input = (
    text: string,
  ): ExternalEngineSessionInput & {
    prompt: Array<{ type: "text"; text: string }>;
  } => ({
    sessionId: "local-session",
    engine,
    cwd: root,
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    prompt: [{ type: "text", text }],
    onSession: vi.fn(async () => {}),
    onConfigOptions: async () => {},
    onUpdate: async (update) => {
      updates.push(update);
    },
    onFailure: async (notice) => {
      notices.push(notice);
    },
    requestPermission: async () => ({ outcome: "cancelled" }),
  });
  const calls = async () =>
    (await readFile(join(root, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  return { port, input, notices, updates, calls };
}

test("只为 Codex 声明 AIR sessionFailure 与 terminal_output_delta，Claude 保持原能力", async () => {
  const codex = await setup("codex");
  await codex.port.prepareSession(codex.input("unused"));
  expect((await codex.calls())[0]?.params.clientCapabilities).toEqual({
    plan: {},
    _meta: {
      jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } },
      terminal_output_delta: true,
    },
  });
  await codex.port.closeSession("local-session");
  const claude = await setup("claude-code");
  await claude.port.prepareSession(claude.input("unused"));
  expect((await claude.calls())[0]?.params.clientCapabilities).toEqual({ plan: {} });
});

test("Codex typed 重试按失败 ID 与 revision 交付，终态失败随 prompt 结果返回且连接保持健康", async () => {
  const f = await setup("codex");
  const result = await f.port.runTurn(f.input("TYPED_RETRY_THEN_FAIL"));
  expect(f.notices).toEqual([
    {
      severity: "warning",
      revision: 1,
      failure: expect.objectContaining({
        code: "provider",
        attempt: 1,
        maxAttempts: 5,
        failureId: "codex-turn-1:error",
        message: "Reconnecting... 1/5",
      }),
    },
    {
      severity: "warning",
      revision: 2,
      failure: expect.objectContaining({ attempt: 2, maxAttempts: 5 }),
    },
  ]);
  // 失败元数据不越过 adapter；session_info_update 只保留标题等事实。
  expect(f.updates.every((update) => !("_meta" in update))).toBe(true);
  expect(result).toMatchObject({
    stopReason: "end_turn",
    failure: {
      code: "provider",
      method: "session/prompt",
      httpStatus: 502,
      retryable: true,
      requestId: "fixture-request",
      url: "https://gateway.example.test/v1/responses",
      failureId: "codex-turn-1:error",
    },
  });
  expect(JSON.stringify([result, f.notices])).not.toContain("fixture-secret");
  expect(f.port.isSessionConnected?.("local-session")).toBe(true);
});

test("非 typed 回退读取 Codex additionalDetails 的状态、URL 与请求 ID", async () => {
  const f = await setup("codex");
  await f.port.runTurn(f.input("LEGACY_RETRY"));
  expect(f.notices).toEqual([
    {
      severity: "warning",
      failure: expect.objectContaining({
        httpStatus: 502,
        attempt: 2,
        maxAttempts: 5,
        requestId: "fixture-request",
        url: "https://gateway.example.test/v1/responses",
        failureId: "codex-turn-2:error",
      }),
    },
  ]);
  expect(f.notices[0]?.failure.message).toContain("unexpected status 502 Bad Gateway");
  expect(JSON.stringify(f.notices)).not.toContain("fixture-secret");
});

test("Claude 的 Internal error: API Error 502 结构化为请求失败，健康连接不被回收", async () => {
  const f = await setup("claude-code");
  await expect(f.port.runTurn(f.input("CLAUDE_502"))).rejects.toMatchObject({
    failure: {
      code: "provider",
      method: "session/prompt",
      rpcCode: -32603,
      httpStatus: 502,
      requestId: "req_fixture01",
      retryable: true,
    },
  });
  expect(f.port.isSessionConnected?.("local-session")).toBe(true);
});
