// E12：真实 Electron/Host/CLI/双向 stdio；仅供应商由隔离夹具替代，不使用真实凭据。
// 启动前运行 helpers/external-engine-fixture.mjs <bin>，将该目录置于 PATH 首位，
// 同时设置 ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN=<bin>，避免探测开发机官方 CLI。
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared/external-engine";
import { resolveE2EStorageRoot } from "../../../helpers/e2e-runtime-paths.js";
import { TID_V4_COMPOSER_SEND, TID_V4_PANE_SHELL, testId } from "@zcode/shared/test-ids";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  getV4FocusedPaneId,
  sendV4Prompt,
  sendV4PromptInPane,
  startNewV4Draft,
  selectV4TaskById,
  setV4ComposerText,
  waitForV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../../../helpers/v4-conversation.js";

import { reloadElectronSessionPreservingBrowserProfile } from "../../../helpers/e2e-electron-reload.js";

const adapter = String.raw`
const readline=require('node:readline'), fs=require('node:fs'), path=require('node:path');
const recoveryPath=path.join(__dirname,'recovery-attempts.json');
const promptPath=path.join(__dirname,'prompt-count.json');
const configControlPath=path.join(__dirname,'config-control.json');
const planDecisionPath=path.join(__dirname,'plan-decisions.json');
const retryReleasePath=path.join(__dirname,'retry-release.json');
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
let mode='ENGINE_ID'==='claude-code'?'default':'safe', model='fixture-0', effort='low', turns=0, pendingPrompt, pendingPlan, planRequestId, typedFailures=false, failSent=false; const sid='fixture-session';
// 帧形状取自 codex-acp 2.2.2 / claude-agent-acp 0.95.0：声明 AIR sessionFailure 时用 typed 失败，否则回退原生形态。
const failureDetails='unexpected status 502 Bad Gateway: Bad gateway, url: https://fixture.invalid/responses?api_key=fixture-secret, request id: fixture-request';
const airFailure=(id,revision,severity,title)=>({jetbrains:{air:{version:1,sessionFailure:{id,revision,category:'connection',severity,title,actions:severity==='error'?['retry','new_session']:[]}}}});
const options=()=>[{id:'fast',name:'Fast mode',currentValue:'off',options:[{value:'off',name:'Off'},{value:'reject',name:'Rejected fast'}]},{id:'mode',name:'Mode',currentValue:mode,options:[{value:'default',name:'Manual'},{value:'auto',name:'Auto'},{value:'plan',name:'Plan'},{value:'safe',name:'Safe'},{value:'full',name:'Full'}]},{id:'model',name:'Model',currentValue:model,options:Array.from({length:18},(_,i)=>({value:'fixture-'+i,name:'Fixture model '+i}))},{id:'EFFORT_ID',name:'Effort',currentValue:effort,options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'},{value:'high',name:'High'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line), result=value=>send({id:f.id,result:value});
 if(!f.method && f.id===planRequestId && pendingPlan){
  const decisions=fs.existsSync(planDecisionPath)?JSON.parse(fs.readFileSync(planDecisionPath,'utf8')):[];
  decisions.push(f.result?.outcome);fs.writeFileSync(planDecisionPath,JSON.stringify(decisions));
  const approved=f.result?.outcome?.outcome==='selected'&&!['revise_plan','reject'].includes(f.result.outcome.optionId);
  if(approved)mode='full';
  send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'config_option_update',configOptions:options()}}});
  send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:approved?'E2E_PLAN_IMPLEMENTED':'E2E_PLAN_REVISED'}}}});
  send({id:pendingPlan.id,result:{stopReason:'end_turn'}});pendingPlan=undefined;planRequestId=undefined;return;
 }
 if(f.method==='session/resume' && fs.existsSync(recoveryPath)){
  const count=JSON.parse(fs.readFileSync(recoveryPath,'utf8'))+1;fs.writeFileSync(recoveryPath,JSON.stringify(count));
  if(count<=2){send({id:f.id,error:{code:-32603,message:'E2E_TEMPORARY_RESUME_FAILURE'}});return;}
 }
 if(f.method==='initialize'){typedFailures=(f.params.clientCapabilities?._meta?.jetbrains?.air?.capabilities??[]).includes('sessionFailure');const initControlPath=path.join(__dirname,'initialize-control.json');const initDelay=fs.existsSync(initControlPath)?JSON.parse(fs.readFileSync(initControlPath,'utf8')).delayMs??0:0;setTimeout(()=>result({protocolVersion:1}),initDelay);}
 else if(f.method==='session/new'||f.method==='session/resume')result({sessionId:sid,configOptions:options()});
 else if(f.method==='session/cancel' && pendingPrompt){
  if(pendingPrompt.params.prompt[0].text==='E2E_EXTERNAL_STOP_EXIT')process.exit(7);
  if(pendingPrompt.params.prompt[0].text==='E2E_EXTERNAL_STOP_BROKEN')send({method:'session/update',params:{sessionId:sid,update:null}});
  else send({id:pendingPrompt.id,result:{stopReason:'cancelled',usage:null}});
  pendingPrompt=undefined;
 }
 else if(f.method==='session/set_config_option'){
  const control=fs.existsSync(configControlPath)?JSON.parse(fs.readFileSync(configControlPath,'utf8')):{};
  const apply=()=>{
  if(f.params.value==='reject'||f.params.value===control.rejectValue){send({id:f.id,error:{code:-32602,message:'unsupported'}});return;}
if(f.params.configId==='mode')mode=f.params.value;else if(f.params.configId==='model')model=f.params.value;else if(f.params.configId==='EFFORT_ID')effort=f.params.value;result({configOptions:options()});
  if(pendingPrompt && effort==='medium'){
   send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_RUNNING_FINAL_'+mode+'_'+model+'_'+effort}}}});
   send({id:pendingPrompt.id,result:{stopReason:'end_turn'}});pendingPrompt=undefined;
  }
  };
  if(control.delayMs)setTimeout(apply,control.delayMs);else apply();
 }
 else if(f.method==='session/prompt'){
  fs.writeFileSync(promptPath,JSON.stringify((fs.existsSync(promptPath)?JSON.parse(fs.readFileSync(promptPath,'utf8')):0)+1));
  if(f.params.prompt[0].text==='E2E_PLAN'){
   pendingPlan=f;planRequestId=70001;
   const markdown='# E2E_NATIVE_PLAN\n\n先检查连接，再验证修改。';
   const update=u=>send({method:'session/update',params:{sessionId:sid,update:u}});
   update({sessionUpdate:'plan',entries:[{content:'E2E_PLAN_CHECK_CONNECTION',status:'pending',priority:'high'}]});
   update({sessionUpdate:'plan_update',plan:{type:'markdown',planId:'fixture-native-plan',content:markdown}});
   send({id:planRequestId,method:'session/request_permission',params:{sessionId:sid,toolCall:{toolCallId:'plan-review:fixture-native-plan',kind:'switch_mode',title:'Implement this plan?',rawInput:{plan:markdown}},options:[{optionId:'implement_plan',kind:'allow_once',name:'Implement'},{optionId:'revise_plan',kind:'reject_once',name:'Revise'}]}});return;
  }
  if(f.params.prompt[0].text==='E2E_RETRY_502'){
   if(fs.existsSync(retryReleasePath))fs.unlinkSync(retryReleasePath);
   const update=u=>send({method:'session/update',params:{sessionId:sid,update:u}});
   const watcher=fs.watch(__dirname,(_event,filename)=>{
    if(String(filename)!=='retry-release.json'||!fs.existsSync(retryReleasePath))return;
    watcher.close();update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_502_RECOVERED'}});result({stopReason:'end_turn'});
   });
   update({sessionUpdate:'session_info_update',_meta:typedFailures?airFailure('fixture-retry:error',1,'warning','Reconnecting... 1/5'):{codex:{error:{message:'Reconnecting... 1/5',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:502}},additionalDetails:failureDetails,turnId:'fixture-retry',willRetry:true}}}});return;
  }
  if(f.params.prompt[0].text==='E2E_FAIL_502'){
   if(failSent){send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_502_RESENT'}}}});result({stopReason:'end_turn'});return;}
   failSent=true;
   if(typedFailures)result({stopReason:'end_turn',usage:null,_meta:{quota:{token_count:null,model_usage:[]},...airFailure('fixture-fail:error',1,'error',failureDetails)}});
   else send({id:f.id,error:{code:-32603,message:'Internal error: API Error: 502 {"type":"error","error":{"type":"api_error","message":"Bad Gateway"},"request_id":"fixture-request"} https://fixture.invalid/responses?api_key=fixture-secret',data:{errorKind:'server_error'}}});
   return;
  }
  if(f.params.prompt[0].text==='E2E_CLAUDE_PLAN'){
   pendingPlan=f;planRequestId=70002;
   const markdown='# E2E_CLAUDE_PLAN\n\n先检查连接。';
   send({id:planRequestId,method:'session/request_permission',params:{sessionId:sid,toolCall:{toolCallId:'toolu_fixture_plan',name:'ExitPlanMode',status:'pending',rawInput:{plan:markdown},title:'Approve Plan',kind:'switch_mode',content:[{type:'content',content:{type:'text',text:markdown}}]},options:[{optionId:'exit-plan-clear-auto',name:'Yes, clear context (12% used) and use auto mode',kind:'allow_always'},{optionId:'exit-plan-auto',name:'Yes, and use auto mode',kind:'allow_always'},{optionId:'exit-plan-bypass',name:'Yes, and bypass permissions',kind:'allow_always'},{optionId:'exit-plan-default',name:'Yes, manually approve edits',kind:'allow_once'},{optionId:'reject',name:'No, keep planning',kind:'reject_once'}]}});return;
  }
  if(f.params.prompt[0].text==='E2E_HTML_PREVIEW'){
   const htmlPath=path.join(process.cwd(),'E2E-preview-login.html');
   const assets=path.join(process.cwd(),'E2E-preview-assets');fs.mkdirSync(assets,{recursive:true});
   fs.writeFileSync(path.join(assets,'styles.css'),'h1{color:rgb(20,80,120);background-image:url("./logo.svg")}');
   fs.writeFileSync(path.join(assets,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="blue"/></svg>');
   fs.writeFileSync(htmlPath,'<!doctype html><meta http-equiv="refresh" content="0;url=/login"><link rel="stylesheet" href="./E2E-preview-assets/styles.css"><h1>E2E_HTML_VISIBLE</h1><img alt="E2E_LOGO" src="./E2E-preview-assets/logo.svg"><script>document.body.dataset.executed="yes";location.href="/login"</script>');
   send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'[E2E_HTML_LINK]('+htmlPath+')'}}}});result({stopReason:'end_turn'});return;
  }
  if(f.params.prompt[0].text.startsWith('E2E_EXTERNAL_STOP_')){
   pendingPrompt=f;send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_STOP_WAITING_'+f.params.prompt[0].text}}}});return;
  }
  if(f.params.prompt[0].text==='E2E_EXTERNAL_RUNNING'){
   pendingPrompt=f;
   const update=u=>send({method:'session/update',params:{sessionId:sid,update:u}});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_RUNNING_CHECKING'}});
   update({sessionUpdate:'tool_call',toolCallId:'fixture-bash',name:'Bash',rawInput:{},status:'pending'});
   update({sessionUpdate:'tool_call_update',toolCallId:'fixture-bash',rawInput:{command:'printf E2E_TERMINAL',description:'E2E_TERMINAL_DESCRIPTION'},status:'in_progress'});
   update({sessionUpdate:'tool_call_update',toolCallId:'fixture-bash',_meta:{terminal_output:{terminal_id:'fixture-bash',data:'E2E_TERMINAL_OUTPUT'}}});
   update({sessionUpdate:'tool_call_update',toolCallId:'fixture-bash',status:'completed',content:[]});
   update({sessionUpdate:'tool_call',toolCallId:'fixture-agent',name:'Agent',rawInput:{description:'E2E_AGENT_PROCESS',subagent_type:'Explore',prompt:'E2E_AGENT_PROMPT'},status:'in_progress'});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_AGENT_ACTIVITY'},_meta:{claudeCode:{parentToolUseId:'fixture-agent'}}});
   update({sessionUpdate:'tool_call',toolCallId:'fixture-child-bash',name:'Bash',rawInput:{command:'printf E2E_CHILD_COMMAND'},status:'in_progress',_meta:{claudeCode:{parentToolUseId:'fixture-agent'}}});
   update({sessionUpdate:'tool_call_update',toolCallId:'fixture-child-bash',status:'completed',content:[],rawOutput:'E2E_CHILD_OUTPUT'});
   update({sessionUpdate:'tool_call_update',toolCallId:'fixture-agent',status:'completed',rawOutput:'E2E_AGENT_RESULT'});
   update({sessionUpdate:'usage_update',used:1234,size:10000});
   update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'E2E_RUNNING_THOUGHT'}});return;
  }
  turns++; const text='E2E_ENGINE_REPLY_'+mode+'_'+model+'_'+effort+'_'+turns;
  send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  result({stopReason:'end_turn'});
 }
});`;

function persistedHistory(sessionId: string) {
  // DOM 历史经过虚拟化与折叠；只读持久化正文验证冷恢复不丢失、不重复。
  const db = new DatabaseSync(join(resolveE2EStorageRoot(), "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      session: db.prepare("SELECT external_session_id FROM session WHERE id = ?").get(sessionId),
      messages: db
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY id")
        .all(sessionId),
      parts: db
        .prepare("SELECT id, data FROM part WHERE session_id = ? ORDER BY id")
        .all(sessionId),
    };
  } finally {
    db.close();
  }
}

async function expandTool(toolCallId: string) {
  const trigger = $(`[data-testid="tool-summary-trigger-${toolCallId}"]`);
  await trigger.waitForDisplayed();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await browser.waitUntil(
    async () =>
      browser.execute((id) => {
        const trigger = document.querySelector<HTMLElement>(
          `[data-testid="tool-summary-trigger-${id}"]`,
        );
        const content = trigger
          ?.closest('[data-slot="collapsible"]')
          ?.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
        return (
          trigger?.getAttribute("aria-expanded") === "true" &&
          Boolean(content && content.getBoundingClientRect().height > 0) &&
          (content?.getAnimations({ subtree: true }) ?? []).every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getComputedTiming().iterations === Infinity,
          )
        );
      }, toolCallId),
    { timeout: 10000, timeoutMsg: `${toolCallId} 必须实际展开并结束布局动画` },
  );
}

async function installExternalEngineFixtures() {
  const bin = process.env.ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN;
  if (!bin || !process.env.PATH?.split(process.platform === "win32" ? ";" : ":").includes(bin))
    throw new Error("需要隔离的官方 CLI 状态夹具 PATH");
  for (const engine of ["claude-code", "codex"] as const) {
    const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
    const root = join(resolveE2EStorageRoot(), "engines", managedAdapterInstallDirName(descriptor));
    const entry = join(root, ...managedAdapterEntrySegments(descriptor));
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(
      entry,
      adapter
        .replaceAll("ENGINE_ID", engine)
        .replaceAll("fixture-child-bash", `${engine}-fixture-child-bash`)
        .replaceAll("fixture-bash", `${engine}-fixture-bash`)
        .replaceAll("fixture-agent", `${engine}-fixture-agent`)
        .replace("Fixture model", `${engine} fixture model`)
        .replaceAll("EFFORT_ID", engine === "codex" ? "reasoning_effort" : "effort"),
    );
    await writeFile(
      join(root, "node_modules", ...descriptor.adapterPackage.split("/"), "package.json"),
      JSON.stringify({ version: descriptor.adapterVersion }),
    );
  }
}

async function displayed(selector: string) {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const element of await $$(selector)) {
        if (await element.isDisplayed()) {
          found = element;
          return true;
        }
      }
      return false;
    },
    { timeout: 30000, timeoutMsg: `等待可见控件 ${selector}` },
  );
  return found!;
}

describe("外部引擎首发前配置与同会话续聊", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const diagnostics = await browser.execute(() => ({
      modelMenus: [
        ...document.querySelectorAll<HTMLElement>('[data-testid="engine-config-menu-model"]'),
      ].map((element) => ({
        visible: element.getClientRects().length > 0,
        rect: element.getBoundingClientRect().toJSON(),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        items: [...element.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((item) => ({
          text: item.innerText,
          rect: item.getBoundingClientRect().toJSON(),
        })),
      })),
      selectors: [
        ...document.querySelectorAll<HTMLElement>('[data-testid="session-engine-select"]'),
      ].map((element) => ({
        text: element.innerText,
        visible: element.getClientRects().length > 0,
      })),
      panes: [...document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]')].map(
        (element) => ({
          id: element.dataset.testid,
          sessionId: element.dataset.sessionId,
          visible: element.getClientRects().length > 0,
        }),
      ),
      drafts: Object.keys(localStorage)
        .filter((key) => key.startsWith("zcode-v4-composer-drafts:v1:"))
        .map((key) => ({ key, value: localStorage.getItem(key) })),
      text: document.body.innerText.slice(-6000),
    }));
    const caseKey = this.currentTest?.title.startsWith("原生计划")
      ? "native-plan"
      : "engine-config";
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `external-engine-${caseKey}-failure.json`),
      JSON.stringify(diagnostics, null, 2),
    );
  });

  it("原生计划审批静态等待且只实施一次，首次502重试可见并恢复", async () => {
    await installExternalEngineFixtures();
    await startNewV4Draft();
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    const paneId = await getV4FocusedPaneId();
    if (!paneId) throw new Error("缺少原生计划回归的当前 pane");
    const paneSelector = `[data-testid="v4-session-pane-${paneId}"]`;
    await (await displayed(`${paneSelector} [data-testid="session-engine-select"]`)).click();
    await $('[role="option"]=Codex').click();
    const mode = () => displayed(`${paneSelector} [data-testid="engine-config-mode"]`);
    await (await mode()).waitForEnabled({ timeout: 30000 });
    const entry = join(
      resolveE2EStorageRoot(),
      "engines",
      managedAdapterInstallDirName(EXTERNAL_ENGINE_RUNTIMES.codex),
      ...managedAdapterEntrySegments(EXTERNAL_ENGINE_RUNTIMES.codex),
    );
    const promptPath = join(dirname(entry), "prompt-count.json");
    const decisionPath = join(dirname(entry), "plan-decisions.json");
    await writeFile(decisionPath, "[]");
    const promptCount = async () =>
      JSON.parse(await readFile(promptPath, "utf8").catch(() => "0")) as number;
    const before = await promptCount();
    for (const start of [true, false]) {
      await (await mode()).click();
      await $('[role="menuitemradio"]=Plan').click();
      await browser.waitUntil(async () => (await (await mode()).getText()) === "Plan");
      await sendV4PromptInPane(paneId, "E2E_PLAN");
      const card = await displayed(`${paneSelector} [data-testid="native-plan-approval"]`);
      expect(await card.getText()).toContain("E2E_PLAN_CHECK_CONNECTION");
      expect(await card.getText()).toContain("E2E_NATIVE_PLAN");
      expect(await $(`${paneSelector} [data-testid="chat-loading"]`).isExisting()).toBe(false);
      if (start) await (await card.$('[data-testid="native-plan-start"]')).doubleClick();
      else await (await card.$('[data-testid="native-plan-revise"]')).click();
      await waitForV4AssistantMessageContaining(
        start ? "E2E_PLAN_IMPLEMENTED" : "E2E_PLAN_REVISED",
      );
      await card.waitForDisplayed({ reverse: true });
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "计划审批原生轮结束",
      );
      if (!start) {
        expect(await (await mode()).getText()).toBe("Plan");
        await browser.waitUntil(
          async () =>
            browser.execute(
              (selector) => document.activeElement?.closest(selector) !== null,
              `${paneSelector} [data-testid="v4-composer-input"]`,
            ),
          { timeoutMsg: "继续修改后焦点应回到当前输入框" },
        );
      }
    }
    expect(JSON.parse(await readFile(decisionPath, "utf8"))).toEqual([
      { outcome: "selected", optionId: "implement_plan" },
      { outcome: "selected", optionId: "revise_plan" },
    ]);
    expect(await promptCount()).toBe(before + 2);
    await sendV4PromptInPane(paneId, "E2E_RETRY_502");
    // Codex 声明 typed sessionFailure 后重试只带原生标题 "Reconnecting... 1/5"（无状态行），
    // 行内错误行显示 n/m，详情可复制上游原文。
    const retry = await displayed(
      `${paneSelector} [data-testid="turn-failure-row"][data-variant="retry"]`,
    );
    await browser.waitUntil(async () => (await retry.getText()).includes("正在重新连接 1/5"));
    await (await retry.$("summary=错误详情")).click();
    expect(await retry.getText()).toContain("Reconnecting... 1/5");
    expect(await retry.getText()).not.toContain("fixture-secret");
    await writeFile(join(dirname(entry), "retry-release.json"), "{}");
    await waitForV4AssistantMessageContaining("E2E_502_RECOVERED");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "502恢复后原生轮结束",
    );
    await retry.waitForDisplayed({ reverse: true });
    expect(await promptCount()).toBe(before + 3);
  });

  it("网关终态失败固定在失败轮末尾、点击才重新发送；Claude 计划卡按原生选项保留上下文开始执行", async () => {
    await installExternalEngineFixtures();
    for (const engine of ["codex", "claude-code"] as const) {
      await startNewV4Draft();
      await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
      const paneId = await getV4FocusedPaneId();
      if (!paneId) throw new Error("缺少错误行回归的当前 pane");
      const paneSelector = `[data-testid="v4-session-pane-${paneId}"]`;
      await (await displayed(`${paneSelector} [data-testid="session-engine-select"]`)).click();
      await $(`[role="option"]=${engine === "codex" ? "Codex" : "Claude Code"}`).click();
      const mode = () => displayed(`${paneSelector} [data-testid="engine-config-mode"]`);
      await (await mode()).waitForEnabled({ timeout: 30000 });
      const entry = join(
        resolveE2EStorageRoot(),
        "engines",
        managedAdapterInstallDirName(EXTERNAL_ENGINE_RUNTIMES[engine]),
        ...managedAdapterEntrySegments(EXTERNAL_ENGINE_RUNTIMES[engine]),
      );
      const promptPath = join(dirname(entry), "prompt-count.json");
      const promptCount = async () =>
        JSON.parse(await readFile(promptPath, "utf8").catch(() => "0")) as number;
      const before = await promptCount();
      // Codex 走 typed 终态（prompt 结果 sessionFailure），Claude 走 JSON-RPC 502；两者都落在同一行内错误行。
      await sendV4PromptInPane(paneId, "E2E_FAIL_502");
      const failure = await displayed(
        `${paneSelector} [data-testid="turn-failure-row"][data-variant="failure"]`,
      );
      await waitForV4ConversationState((snapshot) => snapshot.state !== "running", "失败轮结束");
      expect(await failure.getText()).toContain("HTTP 502");
      await (await failure.$("summary=错误详情")).click();
      const details = await failure.getText();
      expect(details).toContain("fixture-request");
      expect(details).toContain("https://fixture.invalid/responses");
      expect(details).not.toContain("fixture-secret");
      expect(details).not.toContain("api_key");
      // 横幅只承载与轮次无关的错误。
      expect(await $(`${paneSelector} [data-testid="chat-error-banner"]`).isExisting()).toBe(false);
      // 没有自动重发；用户点击后才经正常发送路径重发原文。
      expect(await promptCount()).toBe(before + 1);
      await (await failure.$('[data-testid="turn-failure-resend"]')).click();
      await waitForV4AssistantMessageContaining("E2E_502_RESENT");
      expect(await promptCount()).toBe(before + 2);
      if (engine !== "claude-code") continue;
      const decisionPath = join(dirname(entry), "plan-decisions.json");
      await writeFile(decisionPath, "[]");
      await (await mode()).click();
      await $('[role="menuitemradio"]=Plan').click();
      await browser.waitUntil(async () => (await (await mode()).getText()) === "Plan");
      await sendV4PromptInPane(paneId, "E2E_CLAUDE_PLAN");
      const card = await displayed(`${paneSelector} [data-testid="native-plan-approval"]`);
      expect(await card.getText()).toContain("E2E_CLAUDE_PLAN");
      await (await card.$('[data-testid="native-plan-more"]')).click();
      const clearOption = await displayed(
        '[data-testid="native-plan-option-exit-plan-clear-auto"]',
      );
      expect(await clearOption.getText()).toContain("清空上下文");
      await browser.keys("Escape");
      await (await card.$('[data-testid="native-plan-start"]')).click();
      await waitForV4AssistantMessageContaining("E2E_PLAN_IMPLEMENTED");
      await card.waitForDisplayed({ reverse: true });
      // 进入 Plan 前是新 Claude 会话的 Auto：主按钮保留上下文并回到 Auto，从不选择清空上下文项。
      expect(JSON.parse(await readFile(decisionPath, "utf8"))).toEqual([
        { outcome: "selected", optionId: "exit-plan-auto" },
      ]);
    }
  });

  it("默认引擎在显式选择后由新草稿继承，重启后仍保持本机偏好", async () => {
    await installExternalEngineFixtures();
    await prepareV4ConversationE2E({ skipProvider: true });
    for (const [name, engine] of [
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
    ] as const) {
      await (await displayed('[data-testid="session-engine-select"]')).click();
      await (await displayed(`[role="option"]=${name}`)).click();
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="engine-config-model"]')).getText()).includes(
            `${engine} fixture model`,
          ),
        { timeout: 30000, timeoutMsg: `${name} 选择后必须连接对应引擎` },
      );
      await startNewV4Draft();
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="session-engine-select"]')).getText()).includes(
            name,
          ),
        { timeout: 30000, timeoutMsg: `${name} 显式选择后新草稿必须继承引擎` },
      );
    }
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await startNewV4Draft();
    expect(await (await displayed('[data-testid="session-engine-select"]')).getText()).toContain(
      "Codex",
    );
    await browser.waitUntil(
      async () =>
        (await (await displayed('[data-testid="engine-config-model"]')).getText()).includes(
          "codex fixture model",
        ),
      { timeout: 30000, timeoutMsg: "重启后新草稿必须使用默认 Codex 并连接配置" },
    );
  });

  // P11（external-agent-engines-spec「草稿预热 owner」2026-11-08 草稿无感）：草稿 creating/connecting
  // 即可发送，不显示“正在连接引擎…”；首发排在握手与按引擎记忆恢复（模型→深度）之后，只提交一次。
  it("P11 连接中立即发送：不显示连接中，消息只发一次且使用记忆的模型与深度", async () => {
    await installExternalEngineFixtures();
    await prepareV4ConversationE2E({ skipProvider: true });
    const descriptor = EXTERNAL_ENGINE_RUNTIMES.codex;
    const entry = join(
      resolveE2EStorageRoot(),
      "engines",
      managedAdapterInstallDirName(descriptor),
      ...managedAdapterEntrySegments(descriptor),
    );
    const initializeControlPath = join(dirname(entry), "initialize-control.json");
    await writeFile(initializeControlPath, JSON.stringify({ delayMs: 0 }));
    const promptPath = join(dirname(entry), "prompt-count.json");
    const promptCount = async () =>
      JSON.parse(await readFile(promptPath, "utf8").catch(() => "0")) as number;

    // 1. 就绪草稿中显式选择模型与深度：snapshot 确认后写入 Codex 的本机记忆；首发提升为真实会话。
    await startNewV4Draft();
    await (await displayed('[data-testid="session-engine-select"]')).click();
    await (await displayed('[role="option"]=Codex')).click();
    await (
      await displayed('[data-testid="engine-config-model"]')
    ).waitForEnabled({
      timeout: 30000,
    });
    await (await displayed('[data-testid="engine-config-model"]')).click();
    await (await displayed('[role="menuitemradio"]=codex fixture model 3')).click();
    await browser.waitUntil(
      async () =>
        (await (await displayed('[data-testid="engine-config-model"]')).getText()) ===
        "codex fixture model 3",
      { timeoutMsg: "记忆用模型必须被引擎确认" },
    );
    await (await displayed('[data-testid="engine-config-reasoning_effort"]')).click();
    await (
      await displayed('[data-testid="engine-effort-slider-reasoning_effort"]')
    ).waitForDisplayed();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (testId) => document.activeElement?.getAttribute("data-testid") === testId,
          "engine-effort-slider-reasoning_effort",
        ),
      { timeoutMsg: "打开深度弹层后，键盘焦点必须落在滑动条上" },
    );
    await browser.keys("End");
    await browser.waitUntil(
      async () =>
        (await (await displayed('[data-testid="engine-effort-value"]')).getText()) === "High",
      { timeoutMsg: "记忆用深度必须被引擎确认" },
    );
    await browser.keys("Escape");
    await sendV4Prompt("E2E_MEMORY_SEED");
    await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_safe_fixture-3_high_1");
    await waitForV4ConversationState((s) => s.state === "idle", "记忆种子轮完成");

    // 2. 重启后冷握手（initialize 延迟 3s，且没有补位预建会话）：新草稿出现即输入并发送。
    await writeFile(initializeControlPath, JSON.stringify({ delayMs: 3000 }));
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await startNewV4Draft();
    const paneId = await getV4FocusedPaneId();
    if (!paneId) throw new Error("缺少焦点 pane");
    const shellTestId = testId(TID_V4_PANE_SHELL, paneId);
    const connectingPattern = "正在连接引擎|Connecting to engine";
    // 观察整个草稿 pane：一旦出现连接中文案即记录，不依赖轮询时机。
    await browser.execute(
      (selector, pattern) => {
        const shell = document.querySelector<HTMLElement>(`[data-testid="${selector}"]`);
        if (!shell) throw new Error("缺少草稿 pane");
        const regex = new RegExp(pattern);
        const state = window as typeof window & { __e2eEngineConnectingSeen?: boolean };
        state.__e2eEngineConnectingSeen = regex.test(shell.innerText);
        new MutationObserver(() => {
          if (regex.test(shell.innerText)) state.__e2eEngineConnectingSeen = true;
        }).observe(shell, { subtree: true, childList: true, characterData: true });
      },
      shellTestId,
      connectingPattern,
    );
    const before = await promptCount();
    await setV4ComposerText("E2E_CONNECTING_SEND");
    const atSend = await browser.execute(
      (selector, sendTestId) => {
        const shell = document.querySelector<HTMLElement>(`[data-testid="${selector}"]`);
        const button = shell?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
        const model = shell?.querySelector<HTMLButtonElement>(
          '[data-testid="engine-config-model"]',
        );
        const status = shell?.querySelector(
          '[data-testid="external-engine-controls"] [role="status"]',
        );
        const result = {
          sendEnabled: Boolean(button && !button.disabled),
          // 就绪前原生配置选择器为禁用（或尚无配置）；用来确认确实在连接中发送。
          modelPickerReady: Boolean(model && !model.disabled),
          status: status?.textContent ?? null,
        };
        if (result.sendEnabled) button!.click();
        return result;
      },
      shellTestId,
      TID_V4_COMPOSER_SEND,
    );
    expect(atSend).toEqual({ sendEnabled: true, modelPickerReady: false, status: null });
    await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_safe_fixture-3_high_1");
    await waitForV4ConversationState((s) => s.state === "idle", "连接中首发完成");
    expect(await promptCount()).toBe(before + 1);
    expect(
      await browser.execute(
        () =>
          (window as typeof window & { __e2eEngineConnectingSeen?: boolean })
            .__e2eEngineConnectingSeen,
      ),
    ).toBe(false);
    await writeFile(initializeControlPath, JSON.stringify({ delayMs: 0 }));
  });

  it("两家引擎都先展示配置，首发使用所选模式且续聊复用进程", async () => {
    await installExternalEngineFixtures();
    await prepareV4ConversationE2E({ skipProvider: true });
    for (const [name, engine] of [
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
    ] as const) {
      if (name === "Codex") await startNewV4Draft();
      await (await displayed('[data-testid="session-engine-select"]')).click();
      await (await displayed(`[role="option"]=${name}`)).click();
      await displayed('[data-testid="engine-config-model"]');
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="engine-config-model"]')).getText()).includes(
            `${engine} fixture model`,
          ),
        { timeout: 30000, timeoutMsg: "配置必须属于当前引擎" },
      );
      // 原生 Claude 缺省返回 Manual，客户端须在首发前确认 Auto；Codex 保留原生 Safe。
      expect(await (await displayed('[data-testid="engine-config-mode"]')).getText()).toBe(
        engine === "claude-code" ? "Auto" : "Safe",
      );
      if (engine === "claude-code") {
        await (await displayed('[data-testid="engine-config-mode"]')).click();
        await (await displayed('[role="menuitemradio"]=Manual')).click();
        await browser.waitUntil(
          async () =>
            (await (await displayed('[data-testid="engine-config-mode"]')).getText()) === "Manual",
          { timeoutMsg: "用户显式选择 Manual 后不能被新会话默认值覆盖" },
        );
      }
      await (await displayed('[data-testid="engine-config-mode"]')).click();
      await (await displayed('[role="menuitemradio"]=Full')).click();
      await (await displayed('[data-testid="engine-config-model"]')).click();
      await (await displayed('[data-testid="engine-config-menu-model"]')).waitForDisplayed();
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const menu = document.querySelector<HTMLElement>(
              '[data-testid="engine-config-menu-model"]',
            );
            if (!menu) return false;
            const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
            const rect = menu.getBoundingClientRect();
            return (
              items.length === 18 &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              rect.left >= 0 &&
              rect.right <= innerWidth
            );
          }),
        { timeoutMsg: "完整模型目录必须保留18项且菜单不溢出视口" },
      );
      // 手机宽度允许菜单滚动；逐项实际到达、选择并确认，不能用扩大窗口掩盖溢出。
      for (let index = 0; index < 18; index++) {
        if (index > 0) {
          await $('[data-testid="engine-config-menu-model"]').waitForExist({ reverse: true });
          await (await displayed('[data-testid="engine-config-model"]')).click();
        }
        const modelName = `${engine} fixture model ${index}`;
        const option = await displayed(`[role="menuitemradio"]=${modelName}`);
        await option.scrollIntoView({ block: "nearest" });
        expect(await option.isDisplayed({ withinViewport: true })).toBe(true);
        await option.click();
        await browser.waitUntil(
          async () =>
            (await (await displayed('[data-testid="engine-config-model"]')).getText()) ===
            modelName,
          { timeoutMsg: `模型 ${modelName} 必须可选且保存选择` },
        );
      }
      const effortId = engine === "codex" ? "reasoning_effort" : "effort";
      await (await displayed(`[data-testid="engine-config-${effortId}"]`)).click();
      const slider = await displayed(`[data-testid="engine-effort-slider-${effortId}"]`);
      await slider.waitForDisplayed();
      // 原生 range 的 End 在 keyup 提交，真实配置必须进入后续 prompt 的 ACP 夹具。
      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId) => document.activeElement?.getAttribute("data-testid") === testId,
            `engine-effort-slider-${effortId}`,
          ),
        { timeoutMsg: "打开深度弹层后，键盘焦点必须落在滑动条上" },
      );
      await browser.keys("End");
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="engine-effort-value"]')).getText()) === "High",
      );
      await browser.keys("Escape");
      await sendV4Prompt("E2E_EXTERNAL_PREWARM first");
      await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_full_fixture-17_high_1");
      await waitForV4ConversationState((s) => s.state === "idle", "第一轮完成");
      // 客户端身份来自真实 CLI 摘要；左右布局和置顶操作均经过现有 Host 组织态链路。
      const taskId = (await getV4PaneSnapshot()).sessionId;
      if (!taskId || taskId === "draft") throw new Error("首轮必须提升到真实会话");
      const rowSelector = `[data-testid="task-item-${taskId}"]`;
      await browser.waitUntil(
        async () =>
          browser.execute(
            (selector, expectedEngine) => {
              const row = document.querySelector(selector);
              const logo = row?.querySelector<HTMLImageElement>("[data-task-client-logo] img");
              return (
                row
                  ?.querySelector("[data-task-client-logo]")
                  ?.getAttribute("data-task-client-logo") === expectedEngine &&
                Boolean(logo?.complete && logo.naturalWidth > 0)
              );
            },
            rowSelector,
            engine,
          ),
        { timeoutMsg: "历史会话必须显示实际客户端的本地图标" },
      );
      await (await displayed(rowSelector)).moveTo();
      await (
        await displayed(
          `${rowSelector} button[aria-label="Pin task"], ${rowSelector} button[aria-label="置顶任务"]`,
        )
      ).click();
      const unpinSelector = `${rowSelector} button[aria-label="Unpin task"], ${rowSelector} button[aria-label="取消置顶任务"]`;
      await (await displayed(unpinSelector)).waitForDisplayed();
      expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);
      expect(
        await browser.execute((selector) => {
          const row = document.querySelector(selector);
          const logo = row?.querySelector("[data-task-client-logo]")?.getBoundingClientRect();
          const title = row
            ?.querySelector('[data-task-title-marquee-track="true"]')
            ?.parentElement?.getBoundingClientRect();
          const pin = row?.querySelector("[data-task-pin-action]")?.getBoundingClientRect();
          return Boolean(
            logo && title && pin && logo.right <= title.left && title.right <= pin.left,
          );
        }, rowSelector),
      ).toBe(true);
      const logoArtifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (!logoArtifactDir) throw new Error("缺少截图目录");
      for (const theme of ["light", "dark"] as const) {
        await browser.execute((value) => {
          const actions = (
            window as typeof window & {
              __testActions?: { setTheme?: (value: string) => void };
            }
          ).__testActions;
          if (!actions?.setTheme) throw new Error("缺少主题测试入口");
          actions.setTheme(value);
        }, theme);
        await browser.waitUntil(async () =>
          browser.execute(
            (isDark) => document.documentElement.classList.contains("dark") === isDark,
            theme === "dark",
          ),
        );
        await browser.saveScreenshot(
          join(logoArtifactDir, `${engine}-history-logo-pinned-${theme}.png`),
        );
      }
      await (await displayed(rowSelector)).moveTo();
      await (await displayed(unpinSelector)).click();
      // 取消置顶后按钮会卸载；不能用等待“可见”的 helper 再检查它不存在。
      await browser.waitUntil(
        async () => browser.execute((selector) => !document.querySelector(selector), unpinSelector),
        { timeoutMsg: "取消置顶后，该会话的 Unpin 按钮必须消失" },
      );
      await (await displayed(rowSelector)).moveTo();
      await displayed(
        `${rowSelector} button[aria-label="Pin task"], ${rowSelector} button[aria-label="置顶任务"]`,
      );
      expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);
      await sendV4Prompt("E2E_EXTERNAL_PREWARM continue");
      await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_full_fixture-17_high_2");
      await waitForV4ConversationState((s) => s.state === "idle", "续聊完成");

      // E14：由配置提交释放受控 prompt，不用固定等待掩盖运行中配置的时序。
      await sendV4Prompt("E2E_EXTERNAL_RUNNING");
      await waitForV4AssistantMessageContaining("E2E_RUNNING_CHECKING");
      const modeControl = await displayed('[data-testid="engine-config-mode"]');
      expect(await modeControl.isEnabled()).toBe(true);
      await modeControl.click();
      await (await displayed('[role="menuitemradio"]=Safe')).click();
      await (await displayed('[data-testid="engine-config-model"]')).click();
      await (await displayed(`[role="menuitemradio"]=${engine} fixture model 1`)).click();
      await (await displayed('[data-testid="engine-config-fast"]')).click();
      await (await displayed('[role="menuitemradio"]=Rejected fast')).click();
      await browser.waitUntil(async () =>
        browser.execute(() =>
          /配置修改未生效|Configuration was not changed/.test(document.body.innerText),
        ),
      );
      expect(await (await displayed('[data-testid="engine-config-fast"]')).getText()).toContain(
        "Off",
      );
      await (await displayed(`[data-testid="engine-config-${effortId}"]`)).click();
      await browser.keys("ArrowLeft");
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="engine-effort-value"]')).getText()) === "Medium",
      );
      await browser.keys("Escape");
      await waitForV4AssistantMessageContaining("E2E_RUNNING_FINAL_safe_fixture-1_medium");
      await waitForV4ConversationState((s) => s.state === "idle", "运行中修改后原轮完成");
      const history = await $$('[data-testid^="chat-assistant-history-trigger"]');
      const latestHistory = history[(await history.length) - 1]!;
      await browser.waitUntil(
        async () => (await latestHistory.getAttribute("data-history-open")) === "false",
      );
      expect(
        await browser.execute(() => {
          const body = document.body.innerText;
          return (
            !body.includes("E2E_RUNNING_CHECKING") &&
            body.includes("E2E_RUNNING_FINAL_safe_fixture-1_medium")
          );
        }),
      ).toBe(true);
      await latestHistory.click();
      expect(
        await browser.execute(() => document.body.innerText.includes("E2E_RUNNING_CHECKING")),
      ).toBe(true);
      // E15：真实卡片展开验证命令、输出和父子过程，DOM 文本不能来自主回答。
      const terminal = await displayed(
        `[data-testid="tool-summary-trigger-${engine}-fixture-bash"]`,
      );
      await terminal.waitForDisplayed();
      await expandTool(`${engine}-fixture-bash`);
      await browser.waitUntil(async () =>
        browser.execute(() => {
          const text = document.body.innerText;
          return (
            text.includes("printf E2E_TERMINAL") &&
            text.includes("E2E_TERMINAL_DESCRIPTION") &&
            text.includes("E2E_TERMINAL_OUTPUT")
          );
        }),
      );
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (!artifactDir) throw new Error("缺少 E2E 证据目录");
      await terminal.scrollIntoView();
      await browser.saveScreenshot(join(artifactDir, `${engine}-terminal-details.png`));
      await expandTool(`${engine}-fixture-agent`);
      await browser.waitUntil(async () =>
        browser.execute(() => document.body.innerText.includes("E2E_AGENT_ACTIVITY")),
      );
      await expandTool(`${engine}-fixture-child-bash`);
      await browser.waitUntil(async () =>
        browser.execute(() => document.body.innerText.includes("E2E_CHILD_OUTPUT")),
      );
      const usage = await displayed('[data-testid="chat-context-usage-trigger"]');
      await usage.waitForDisplayed();
      expect(await usage.getAttribute("aria-label")).toContain("1,234");
      expect(await usage.getAttribute("aria-label")).toContain("10,000");
      await (
        await displayed(`[data-testid="tool-summary-trigger-${engine}-fixture-agent"]`)
      ).scrollIntoView();
      await browser.saveScreenshot(join(artifactDir, `${engine}-agent-details.png`));
      // E16：真正重启 Electron/Host/CLI，恢复原生配置后才能发送，草稿不可丢失。
      const draft = `E2E_RESTORE_DRAFT_${engine}`;
      await setV4ComposerText(draft);
      const recoveryPath = join(
        resolveE2EStorageRoot(),
        "engines",
        managedAdapterInstallDirName(EXTERNAL_ENGINE_RUNTIMES[engine]),
        ...managedAdapterEntrySegments(EXTERNAL_ENGINE_RUNTIMES[engine]),
        "..",
        "recovery-attempts.json",
      );
      await writeFile(recoveryPath, "0");
      const beforeRecovery = persistedHistory(taskId);
      expect(beforeRecovery.session).toMatchObject({
        external_session_id: "fixture-session",
      });
      expect(beforeRecovery.messages.length).toBeGreaterThan(0);
      expect(beforeRecovery.parts.length).toBeGreaterThan(0);
      const promptPath = join(dirname(recoveryPath), "prompt-count.json");
      const promptsBeforeRecovery = JSON.parse(await readFile(promptPath, "utf8"));
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await selectV4TaskById(taskId);
      await waitForV4ComposerText(draft, "冷恢复必须保留未发送草稿");
      await browser.waitUntil(
        async () => {
          const model = await displayed('[data-testid="engine-config-model"]');
          return (
            (await model.isEnabled()) &&
            (await model.getText()).includes(`${engine} fixture model 1`)
          );
        },
        {
          timeout: 30000,
          timeoutMsg: "冷恢复必须显示上次选择且已连接原生会话",
        },
      );
      expect(JSON.parse(await readFile(recoveryPath, "utf8"))).toBe(3);
      expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);
      expect(persistedHistory(taskId)).toEqual(beforeRecovery);
      expect(JSON.parse(await readFile(promptPath, "utf8"))).toBe(promptsBeforeRecovery);
      expect(await (await displayed('[data-testid="engine-config-mode"]')).getText()).toContain(
        "Safe",
      );
      await (await displayed(`[data-testid="engine-config-${effortId}"]`)).click();
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="engine-effort-value"]')).getText()) === "Medium",
        { timeoutMsg: "恢复的思考深度必须显示为 Medium" },
      );
      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId) => document.activeElement?.getAttribute("data-testid") === testId,
            `engine-effort-slider-${effortId}`,
          ),
        { timeoutMsg: "冷恢复后打开深度弹层仍须聚焦滑动条" },
      );
      await browser.keys("End");
      await browser.waitUntil(
        async () =>
          (await (await displayed('[data-testid="engine-effort-value"]')).getText()) === "High",
      );
      await browser.keys("Escape");
      await setV4ComposerText("");
      await sendV4Prompt("E2E_EXTERNAL_RESTORED");
      await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_safe_fixture-1_high_1");
      await waitForV4ConversationState((s) => s.state === "idle", "冷恢复后继续同一会话");
      await browser.saveScreenshot(join(artifactDir, `${engine}-restored-settings.png`));
    }
    // 最后一次显式选择成为本机默认；新草稿及重启后新草稿都继承 Codex。
    await startNewV4Draft();
    await expect(await displayed('[data-testid="session-engine-select"]')).toHaveText(
      expect.stringContaining("Codex"),
    );
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await startNewV4Draft();
    await expect(await displayed('[data-testid="session-engine-select"]')).toHaveText(
      expect.stringContaining("Codex"),
    );
  });

  it("停止后自动恢复原会话并直接调节思考深度", async () => {
    await installExternalEngineFixtures();
    await prepareV4ConversationE2E({ skipProvider: true });
    for (const [name, engine] of [
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
    ] as const) {
      if (engine === "codex") await startNewV4Draft();
      const paneId = await getV4FocusedPaneId();
      if (!paneId) throw new Error("缺少停止回归的当前 pane");
      const paneSelector = `[data-testid="v4-session-pane-${paneId}"]`;
      await (await displayed(`${paneSelector} [data-testid="session-engine-select"]`)).click();
      await $(`[role="option"]=${name}`).click();
      const effortId = engine === "codex" ? "reasoning_effort" : "effort";
      const effort = () => displayed(`${paneSelector} [data-testid="engine-config-${effortId}"]`);
      await (await effort()).waitForEnabled({ timeout: 30000 });
      const selectEffort = async (key: string, expected: string) => {
        await (await effort()).waitForClickable();
        await (await effort()).click();
        const slider = $(`[data-testid="engine-effort-slider-${effortId}"]`);
        await slider.waitForClickable();
        // 点击滑条中点会额外提交 Medium；等待原生自动聚焦后仅提交目标档位。
        await browser.waitUntil(async () =>
          browser.execute(
            (id) => document.activeElement?.getAttribute("data-testid") === id,
            `engine-effort-slider-${effortId}`,
          ),
        );
        await browser.keys(key);
        await browser.waitUntil(
          async () => (await (await effort()).getAttribute("title")) === expected,
        );
        await browser.keys("Escape");
        await $('[data-testid="engine-effort-value"]').waitForDisplayed({
          reverse: true,
        });
      };
      await selectEffort("End", "High");
      for (const scenario of ["HEALTHY", "BROKEN", "EXIT"]) {
        await selectEffort("End", "High");
        const prompt = `E2E_EXTERNAL_STOP_${scenario}`;
        await sendV4PromptInPane(paneId, prompt);
        await waitForV4AssistantMessageContaining(`E2E_STOP_WAITING_${prompt}`);
        const taskId = (await getV4PaneSnapshot()).sessionId;
        if (!taskId) throw new Error("缺少停止回归的会话 ID");
        const originalSession = persistedHistory(taskId).session;
        await (await displayed(`${paneSelector} [data-testid="v4-stop"]`)).click();
        await waitForV4ConversationState((snapshot) => snapshot.state === "idle", "停止收尾完成");
        const reconnect = $("button=重新连接");
        if (scenario === "HEALTHY") {
          expect(await reconnect.isExisting()).toBe(false);
          expect(await (await effort()).isEnabled()).toBe(true);
          expect(await (await effort()).getAttribute("title")).toBe("High");
        } else {
          expect(await reconnect.isExisting()).toBe(false);
          const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
          const promptPath = join(
            resolveE2EStorageRoot(),
            "engines",
            managedAdapterInstallDirName(descriptor),
            ...managedAdapterEntrySegments(descriptor),
            "..",
            "prompt-count.json",
          );
          const promptCount = JSON.parse(await readFile(promptPath, "utf8"));
          await browser.waitUntil(
            async () => (await (await effort()).getAttribute("title")) === "High",
          );
          await selectEffort("Home", "Low");
          expect(persistedHistory(taskId).session).toEqual(originalSession);
          expect(JSON.parse(await readFile(promptPath, "utf8"))).toBe(promptCount);
        }
      }
    }
  });

  it("HTML 文件链接静态预览保留页面，并可切换源码", async () => {
    await installExternalEngineFixtures();
    await startNewV4Draft();
    await prepareV4ConversationE2E({
      skipProvider: true,
      skipShellReady: true,
    });
    const paneId = await getV4FocusedPaneId();
    if (!paneId) throw new Error("缺少 HTML 预览的当前 pane");
    const paneSelector = `[data-testid="v4-session-pane-${paneId}"]`;
    await (await displayed(`${paneSelector} [data-testid="session-engine-select"]`)).click();
    await $('[role="option"]=Codex').click();
    await (
      await displayed(`${paneSelector} [data-testid="engine-config-model"]`)
    ).waitForEnabled({ timeout: 30000 });
    await sendV4PromptInPane(paneId, "E2E_HTML_PREVIEW");
    await waitForV4AssistantMessageContaining("E2E_HTML_LINK");
    await waitForV4ConversationState((snapshot) => snapshot.state === "idle", "HTML 链接生成完成");
    await (await displayed("button=E2E_HTML_LINK")).click();
    const frame = $('[data-testid="html-file-preview"]');
    try {
      await frame.waitForDisplayed({ timeout: 30000 });
    } catch (error) {
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir) await browser.saveScreenshot(join(artifactDir, "html-preview-failed.png"));
      const diagnostics = await browser.execute(() => ({
        previews: [
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid*="preview"], [data-testid*="side-pane"]',
          ),
        ].map((node) => ({
          id: node.dataset.testid,
          text: node.innerText.slice(0, 600),
        })),
        notifications: [
          ...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]'),
        ].map((node) => node.innerText),
      }));
      throw new Error(`HTML 预览未显示 ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    expect(await frame.getAttribute("sandbox")).toBe("");
    await browser.switchFrame(frame);
    try {
      await $("h1=E2E_HTML_VISIBLE").waitForDisplayed();
      expect(await browser.execute(() => document.body.dataset.executed ?? null)).toBe(null);
      expect(await browser.execute(() => location.href)).toBe("about:srcdoc");
      expect(
        await browser.execute(() => getComputedStyle(document.querySelector("h1")!).color),
      ).toBe("rgb(20, 80, 120)");
      expect(
        await browser.execute(
          () => getComputedStyle(document.querySelector("h1")!).backgroundImage,
        ),
      ).toContain("data:image/svg+xml;base64,");
      await browser.waitUntil(async () =>
        browser.execute(
          () =>
            document.querySelector<HTMLImageElement>('img[alt="E2E_LOGO"]')?.naturalWidth === 12,
        ),
      );
    } finally {
      await browser.switchFrame(null);
    }
    const preview = $('[data-testid="preview-pane"]');
    // 文件预览标题栏通过 portal 挂在文件管理器顶栏，不在正文 aside 内。
    const more = () => displayed('[data-file-manager-pane] button[aria-label="更多"]');
    await (await more()).click();
    await $('[role="menuitem"]=用内置浏览器运行').waitForDisplayed();
    await $('[role="menuitemradio"]=源码').click();
    await frame.waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => (await preview.getText()).includes("E2E_HTML_VISIBLE"));
    await $('[role="menu"]').waitForExist({ reverse: true });
    await (await more()).click();
    await (await displayed('[role="menuitemradio"]=预览')).click();
    await frame.waitForDisplayed();
    await browser.switchFrame(frame);
    try {
      await $("h1=E2E_HTML_VISIBLE").waitForDisplayed();
      expect(await browser.execute(() => location.href)).toBe("about:srcdoc");
    } finally {
      await browser.switchFrame(null);
    }
    await $('[role="menu"]').waitForExist({ reverse: true });
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir) await browser.saveScreenshot(join(artifactDir, "html-static-preview.png"));
  });

  it("深度提交等待确认时不回跳，拒绝后恢复确认值", async () => {
    await installExternalEngineFixtures();
    await startNewV4Draft();
    await prepareV4ConversationE2E({
      skipProvider: true,
      skipShellReady: true,
    });
    for (const [name, engine] of [
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
    ] as const) {
      if (engine === "codex") await startNewV4Draft();
      await (await displayed('[data-testid="session-engine-select"]')).click();
      await $(`[role="option"]=${name}`).click();
      const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
      const controlPath = join(
        resolveE2EStorageRoot(),
        "engines",
        managedAdapterInstallDirName(descriptor),
        ...managedAdapterEntrySegments(descriptor),
        "..",
        "config-control.json",
      );
      // 受控延迟制造真实异步确认窗口，保证回跳不能被快速 ACP 响应掩盖。
      await writeFile(controlPath, JSON.stringify({ delayMs: 400 }));
      const effortId = engine === "codex" ? "reasoning_effort" : "effort";
      const trigger = await displayed(`[data-testid="engine-config-${effortId}"]`);
      await trigger.waitForEnabled();
      await browser.electron.execute((electron, narrow) => {
        const win = electron.BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed(),
        );
        win?.setMinimumSize(320, 500);
        win?.setContentSize(narrow ? 430 : 1280, 812);
      }, engine === "codex");
      await browser.execute((dark) => {
        const actions = (
          window as typeof window & {
            __testActions?: { setTheme?: (value: string) => void };
          }
        ).__testActions;
        if (!actions?.setTheme) throw new Error("缺少主题测试入口");
        actions.setTheme(dark ? "dark" : "light");
      }, engine === "codex");
      await browser.waitUntil(async () =>
        browser.execute(
          (narrow) =>
            innerWidth === (narrow ? 430 : 1280) &&
            document.documentElement.classList.contains("dark") === narrow,
          engine === "codex",
        ),
      );
      await trigger.click();
      const slider = $(`[data-testid="engine-effort-slider-${effortId}"]`);
      await slider.waitForClickable();
      for (const [eventName, expected, key] of [
        ["pointerup", "High", "End"],
        ["keyup", "Low", "Home"],
      ] as const) {
        await browser.execute(
          (id, event) => {
            const input = document.querySelector<HTMLInputElement>(
              `[data-testid="engine-effort-slider-${id}"]`,
            )!;
            delete input.dataset.commitTrace;
            input.addEventListener(
              event,
              () => {
                const values = [input.value];
                let frame: number;
                const sample = () => {
                  values.push(input.value);
                  frame = requestAnimationFrame(sample);
                };
                frame = requestAnimationFrame(sample);
                setTimeout(() => {
                  cancelAnimationFrame(frame);
                  input.dataset.commitTrace = JSON.stringify(values);
                }, 800);
              },
              { once: true },
            );
          },
          effortId,
          eventName,
        );
        if (eventName === "pointerup") {
          const point = await browser.execute((id) => {
            const rect = document
              .querySelector(`[data-testid="engine-effort-slider-${id}"]`)!
              .getBoundingClientRect();
            return {
              left: Math.round(rect.left + 14),
              right: Math.round(rect.right - 14),
              y: Math.round(rect.top + rect.height / 2),
            };
          }, effortId);
          await browser.performActions([
            {
              type: "pointer",
              id: "effort-drag",
              parameters: { pointerType: "mouse" },
              actions: [
                { type: "pointerMove", duration: 0, x: point.left, y: point.y },
                { type: "pointerDown", button: 0 },
                {
                  type: "pointerMove",
                  duration: 150,
                  x: point.right,
                  y: point.y,
                },
                { type: "pointerUp", button: 0 },
              ],
            },
          ]);
          await browser.releaseActions();
        } else await browser.keys(key);
        await browser.waitUntil(async () =>
          Boolean(await slider.getAttribute("data-commit-trace")),
        );
        const values: string[] = JSON.parse((await slider.getAttribute("data-commit-trace"))!);
        expect(values.length).toBeGreaterThan(1);
        expect(values.every((value) => value === (expected === "High" ? "2" : "0"))).toBe(true);
        expect(await trigger.getAttribute("title")).toBe(expected);
        const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
        if (!artifactDir) throw new Error("缺少滑块回归证据目录");
        await writeFile(
          join(artifactDir, `${engine}-${eventName}-slider-trace.json`),
          JSON.stringify(values),
        );
        await browser.saveScreenshot(join(artifactDir, `${engine}-${eventName}-slider.png`));
      }
      await writeFile(controlPath, JSON.stringify({ delayMs: 400, rejectValue: "high" }));
      await browser.keys("End");
      await browser.waitUntil(async () => (await slider.getAttribute("aria-valuetext")) === "High");
      expect(await trigger.getAttribute("title")).toBe("Low");
      await browser.waitUntil(async () => (await slider.getAttribute("aria-valuetext")) === "Low");
      expect(await trigger.getAttribute("title")).toBe("Low");
      await browser.keys("Escape");
    }
  });
});
