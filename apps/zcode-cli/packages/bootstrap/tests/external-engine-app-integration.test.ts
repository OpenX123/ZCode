import { mkdtemp, mkdir, writeFile, rename, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "@zcode/provider";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionId, SessionEventType } from "@zcode/contracts";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared/external-engine";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import { createZCodeApp } from "../src/app/create-app.js";

// 真实双向 stdio 与 SQLite，只有外部供应商用受控 ACP 子进程代替，避免调用真实账号。
const adapter = String.raw`
const readline = require('node:readline');
const selected={model:'test',effort:'low'};
let pending;
const log=method=>require('node:fs').appendFileSync(process.env.ACP_TEST_REQUESTS,method+'\n');
const configs=()=>Object.entries(selected).map(([id,currentValue])=>({id,name:id,type:'select',currentValue,options:(id==='model'?['test','other']:['low','high','reject']).map(value=>({value,name:value}))}));
const send = (frame) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n');
readline.createInterface({input:process.stdin}).on('line', (line) => {
 const f=JSON.parse(line); log(f.method); const sid=f.params.sessionId || 'external-test-session';
 const update=(u)=>send({method:'session/update',params:{sessionId:sid,update:u}});
 if(f.method==='initialize') send({id:f.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(f.method==='session/new' || f.method==='session/resume') {
  update({sessionUpdate:'available_commands_update',availableCommands:[{name:'compact',description:'compact context'}]});
  send({id:f.id,result:{sessionId:sid,configOptions:configs()}});
 }
 if(f.method==='session/set_config_option') {
  if(f.params.value==='reject') { send({id:f.id,error:{code:-32602,message:'unsupported'}});return; }
  selected[f.params.configId]=f.params.value;send({id:f.id,result:{configOptions:configs()}});
 }
 if(f.method==='session/cancel' && pending) {
  if(pending.params.prompt[0].text==='broken-cancel') update(null);
  else send({id:pending.id,result:{stopReason:'cancelled'}});
  pending=undefined;return;
 }
 if(f.method==='session/prompt') {
  if(['healthy-cancel','broken-cancel'].includes(f.params.prompt[0].text)) {
   pending=f;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'waiting-for-stop-'+f.params.prompt[0].text}});return;
  }
  if(f.params.prompt[0].text==='disconnect') { process.exit(7); }
  if(f.params.prompt[0].text==='interleaved') {
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'checking files'}});
   update({sessionUpdate:'tool_call',toolCallId:'bash-1',name:'Bash',rawInput:{},status:'pending'});
   update({sessionUpdate:'tool_call_update',toolCallId:'bash-1',rawInput:{command:'pwd',description:'查看工作目录'},status:'in_progress'});
   update({sessionUpdate:'tool_call_update',toolCallId:'bash-1',_meta:{terminal_output:{terminal_id:'bash-1',data:'work'}}});
   update({sessionUpdate:'tool_call_update',toolCallId:'bash-1',_meta:{terminal_output_delta:{terminal_id:'bash-1',data:'space'}}});
   update({sessionUpdate:'tool_call_update',toolCallId:'bash-1',status:'completed',content:[]});
   update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'reviewing output'}});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'final answer'}});
   send({id:f.id,result:{stopReason:'end_turn'}});return;
  }

  if(f.params.prompt[0].text==='agents') {
   const child=(id,u)=>update({...u,_meta:{claudeCode:{parentToolUseId:id,...u._meta?.claudeCode}}});
   for(const id of ['agent-a','agent-b']) update({sessionUpdate:'tool_call',toolCallId:id,name:'Agent',rawInput:{description:id,subagent_type:'Explore',prompt:'检查文件'},status:'in_progress'});
   child('agent-b',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'B 子任务活动'}});
   child('agent-a',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'A 子任务思考'}});
   child('agent-b',{sessionUpdate:'tool_call',toolCallId:'child-bash',name:'Bash',rawInput:{},status:'pending'});
   child('agent-b',{sessionUpdate:'tool_call_update',toolCallId:'child-bash',rawInput:{command:'echo child'},status:'in_progress'});
   child('agent-b',{sessionUpdate:'tool_call_update',toolCallId:'child-bash',status:'completed',content:[],rawOutput:[{type:'text',text:'child output'}]});
   child('agent-a',{sessionUpdate:'tool_call',toolCallId:'child-failed',name:'Bash',rawInput:{command:'exit 7'},status:'in_progress'});
   child('agent-a',{sessionUpdate:'tool_call_update',toolCallId:'child-failed',status:'failed',rawOutput:'Exit code 7\nfailed command'});
   child('agent-a',{sessionUpdate:'tool_call_update',toolCallId:'child-failed',rawInput:{command:'stale'},status:'in_progress'});
   for(const id of ['agent-b','agent-a']) update({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:'完成 '+id});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'主回答'}});
   send({id:f.id,result:{stopReason:'end_turn'}});return;
  }
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:f.params.prompt[0].text==='continue'?'resumed answer':'external answer'}});
  update({sessionUpdate:'usage_update',used:12,size:1000});
  send({id:f.id,result:{stopReason:'end_turn',usage:{inputTokens:2,outputTokens:3}}});
 }
});
`;

describe("外部引擎 App 集成", () => {
  it.each(["claude-code", "codex"] as const)(
    "%s 在空 Registry 中真实启动进程、落盘并冷恢复续聊",
    async (engine) => {
      const root = await mkdtemp(join(tmpdir(), "ycode-external-app-"));
      const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
      const enginesDir = join(root, "engines");
      const entry = join(
        enginesDir,
        managedAdapterInstallDirName(runtime),
        ...managedAdapterEntrySegments(runtime),
      );
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(entry, adapter);
      const store = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
      const sessionId = createSessionId();
      const env = {
        ...process.env,
        HOME: root,
        ZCODE_EXTERNAL_ENGINE_USER_HOME: root,
        ZCODE_EXTERNAL_ENGINES_DIR: enginesDir,
        ACP_TEST_REQUESTS: join(root, "requests.log"),
      };
      const eventStore = createInMemorySessionEventStore();
      const options = {
        env,
        eventStore,
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
        providerRegistry: new ProviderRegistry([]),
        runtimeConfig: { engine, workingDirectory: root },
      };
      let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;
      try {
        app = await createZCodeApp(options);
        await app.runtime.prepareExternalEngineSession();
        expect(app.runtime.getEngineConfigOptions()).toMatchObject([
          { id: "model", currentValue: "test" },
          { id: "effort", currentValue: "low" },
        ]);
        await app.runtime.setEngineConfigOption("model", "other");
        await app.runtime.setEngineConfigOption("effort", "high");
        expect(
          (await eventStore.getEvents(sessionId)).some(
            (event) => event.type === SessionEventType.TurnStarted,
          ),
        ).toBe(false);
        const result = await app.submitPrompt("hello");
        expect(result.response).toBe("external answer");
        const events = await eventStore.getEvents(sessionId);
        expect(events.map((event) => event.type)).toContain(
          SessionEventType.ExternalEngineCommandsUpdated,
        );
        expect(
          events.some((event) => event.type === SessionEventType.ExternalEngineUsageUpdated),
        ).toBe(true);
        expect((await store.getSession(sessionId))?.engine).toBe(engine);
        expect((await store.getSession(sessionId))?.externalSessionId).toBe(
          "external-test-session",
        );
        // 复现真实流式错位：同一 assistant message 中工具前后的正文不能拼进同一行。
        await app.submitPrompt("interleaved");
        const projection = new ProductProjection(String(sessionId), "external-regression");
        projection.seedConfig({ engine, engineConfigOptions: [] });
        for (const event of await eventStore.getEvents(sessionId)) projection.applyEvent(event);
        const rows = projection.getSnapshot().rows.window;
        const checking = rows.findIndex(
          (row) => row.kind === "assistantText" && row.text === "checking files",
        );
        expect(checking).toBeGreaterThanOrEqual(0);
        expect(rows.slice(checking).map((row) => row.kind)).toEqual([
          "assistantText",
          "toolCall",
          "reasoning",
          "assistantText",
        ]);
        expect(rows.at(-1)).toMatchObject({
          kind: "assistantText",
          text: "final answer",
          state: "complete",
        });
        const streaming = (await eventStore.getEvents(sessionId))
          .filter((event) => event.type === SessionEventType.ModelStreaming)
          .map((event) => (event.payload as { kind: string }).kind);
        expect(streaming.slice(-9)).toEqual([
          "text_start",
          "text_delta",
          "text_end",
          "reasoning_start",
          "reasoning_delta",
          "reasoning_end",
          "text_start",
          "text_delta",
          "text_end",
        ]);
        const bash = rows.find((row) => row.kind === "toolCall");
        expect(bash).toMatchObject({
          input: { command: "pwd", description: "查看工作目录" },
          output: { text: "workspace" },
        });
        const liveTools = new ProductProjection(String(sessionId), "live-details");
        let runningOutputCount = 0;
        for (const event of await eventStore.getEvents(sessionId)) {
          liveTools.applyEvent(event);
          if (
            event.type === SessionEventType.ToolCallProgress &&
            (event.payload as { output?: string }).output === "work"
          ) {
            runningOutputCount++;
            expect(
              liveTools.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
            ).toMatchObject({
              status: "running",
              input: { command: "pwd" },
              output: { text: "work" },
            });
          }
        }
        expect(runningOutputCount).toBe(1);
        expect((await app.submitPrompt("agents")).response).toBe("主回答");
        const agentProjection = new ProductProjection(String(sessionId), "agents");
        for (const event of await eventStore.getEvents(sessionId))
          agentProjection.applyEvent(event);
        const checkAgentDetails = (projection: ProductProjection) => {
          const toolRows = projection
            .getSnapshot()
            .rows.window.filter((row) => row.kind === "toolCall");
          expect(toolRows.find((row) => row.toolCallId === "child-bash")).toMatchObject({
            parentToolCallId: "agent-b",
            input: { command: "echo child" },
            output: { text: "child output" },
          });
          expect(toolRows.find((row) => row.toolCallId === "child-failed")).toMatchObject({
            parentToolCallId: "agent-a",
            status: "error",
            input: { command: "exit 7" },
            output: { text: "Exit code 7\nfailed command" },
            error: { message: "Exit code 7\nfailed command" },
          });
          expect(toolRows.find((row) => row.toolCallId === "agent-a")).toMatchObject({
            activityText: "A 子任务思考",
            output: { text: "完成 agent-a" },
          });
          expect(toolRows.find((row) => row.toolCallId === "agent-b")).toMatchObject({
            activityText: "B 子任务活动",
            output: { text: "完成 agent-b" },
          });
        };
        checkAgentDetails(agentProjection);
        const cold = new ProductProjection(String(sessionId), "cold-details");
        for (const event of synthesizeEventsFromMessages(
          await store.messages({ sessionID: sessionId }),
          { sessionId: String(sessionId) },
        ))
          cold.applyEvent(event);
        checkAgentDetails(cold);
        // 停止时的非法通知会使 adapter 清理连接；必须同步撤销 ready，重连不能重发 prompt。
        for (const scenario of ["healthy-cancel", "broken-cancel", "disconnect"]) {
          let completion: Promise<unknown>;
          if (scenario === "disconnect") {
            completion = app.submitPrompt(scenario).catch(() => undefined);
          } else {
            completion = app.submitPrompt(scenario).catch(() => undefined);
            await vi.waitFor(async () => {
              expect(JSON.stringify(await eventStore.getEvents(sessionId))).toContain(
                `waiting-for-stop-${scenario}`,
              );
            });
            app.runtime.stopActiveForegroundExecution();
          }
          await completion;
          expect(app.runtime.getEngineConfigState()).toBe(
            scenario === "healthy-cancel" ? "ready" : "error",
          );
          expect(app.runtime.getEngineConfigOptions()[1]?.currentValue).toBe("high");
          const before = (await readFile(env.ACP_TEST_REQUESTS, "utf8"))
            .split("\n")
            .filter((method) => method === "session/prompt").length;
          await app.runtime.prepareExternalEngineSession();
          expect(app.runtime.getEngineConfigState()).toBe("ready");
          await app.runtime.setEngineConfigOption("effort", "low");
          expect(app.runtime.getEngineConfigOptions()[1]?.currentValue).toBe("low");
          await app.runtime.setEngineConfigOption("effort", "high");
          await expect(app.runtime.setEngineConfigOption("effort", "reject")).rejects.toThrow();
          expect(app.runtime.getEngineConfigState()).toBe("ready");
          expect((await store.getSession(sessionId))?.externalSessionId).toBe(
            "external-test-session",
          );
          const requests = (await readFile(env.ACP_TEST_REQUESTS, "utf8")).split("\n");
          expect(requests.filter((method) => method === "session/prompt")).toHaveLength(before);
          expect(requests.filter((method) => method === "session/new")).toHaveLength(1);
        }
        const transcript = JSON.stringify(await store.messages({ sessionID: sessionId }));
        expect(transcript).toContain("external answer");
        await app.close();
        app = await createZCodeApp({
          ...options,
          eventStore: createInMemorySessionEventStore(),
          resume: true,
          runtimeConfig: { ...options.runtimeConfig, externalSessionId: "external-test-session" },
        });
        await app.resume();
        expect(app.runtime.getEngineConfigOptions()).toMatchObject([
          { id: "model", currentValue: "other" },
          { id: "effort", currentValue: "high" },
        ]);
        await app.runtime.setEngineConfigOption("effort", "low");
        expect(app.runtime.getEngineConfigOptions()[1]?.currentValue).toBe("low");
        expect((await app.submitPrompt("continue")).response).toBe("resumed answer");
        expect(JSON.stringify(await app.loadSessionTranscript())).toContain("external answer");
        expect(app.runtime.getEngineConfigState()).toBe("ready");
        await app.close();
        // 断开引擎安装入口复现离线恢复；历史和上次选择仍须可读，重试不能新建上下文。
        await rename(entry, `${entry}.offline`);
        app = await createZCodeApp({
          ...options,
          eventStore: createInMemorySessionEventStore(),
          resume: true,
        });
        await app.resume();
        expect(app.runtime.getEngineConfigState()).toBe("error");
        expect(app.runtime.getEngineConfigOptions()).toMatchObject([
          { id: "model", currentValue: "other" },
          { id: "effort", currentValue: "low" },
        ]);
        expect(JSON.stringify(await app.loadSessionTranscript())).toContain("external answer");
        await rename(`${entry}.offline`, entry);
        await Promise.all([
          app.runtime.prepareExternalEngineSession(),
          app.runtime.prepareExternalEngineSession(),
        ]);
        expect(app.runtime.getEngineConfigState()).toBe("ready");
        expect(app.runtime.getEngineConfigOptions()[0]?.currentValue).toBe("other");
        const requests = (await readFile(join(root, "requests.log"), "utf8")).trim().split("\n");
        expect(requests.filter((method) => method === "session/new")).toHaveLength(1);
        expect(requests.filter((method) => method === "session/resume")).toHaveLength(4);
        expect(requests.filter((method) => method === "session/prompt")).toHaveLength(7);
      } finally {
        await app?.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
