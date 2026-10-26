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
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  sendV4Prompt,
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
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
let mode='ENGINE_ID'==='claude-code'?'default':'safe', model='fixture-0', effort='low', turns=0, pendingPrompt; const sid='fixture-session';
const options=()=>[{id:'fast',name:'Fast mode',currentValue:'off',options:[{value:'off',name:'Off'},{value:'reject',name:'Rejected fast'}]},{id:'mode',name:'Mode',currentValue:mode,options:[{value:'default',name:'Manual'},{value:'auto',name:'Auto'},{value:'safe',name:'Safe'},{value:'full',name:'Full'}]},{id:'model',name:'Model',currentValue:model,options:Array.from({length:18},(_,i)=>({value:'fixture-'+i,name:'Fixture model '+i}))},{id:'EFFORT_ID',name:'Effort',currentValue:effort,options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'},{value:'high',name:'High'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line), result=value=>send({id:f.id,result:value});
 if(f.method==='session/resume' && fs.existsSync(recoveryPath)){
  const count=JSON.parse(fs.readFileSync(recoveryPath,'utf8'))+1;fs.writeFileSync(recoveryPath,JSON.stringify(count));
  if(count<=2){send({id:f.id,error:{code:-32603,message:'E2E_TEMPORARY_RESUME_FAILURE'}});return;}
 }
 if(f.method==='initialize')result({protocolVersion:1});
 else if(f.method==='session/new'||f.method==='session/resume')result({sessionId:sid,configOptions:options()});
 else if(f.method==='session/set_config_option'){
  if(f.params.value==='reject'){send({id:f.id,error:{code:-32602,message:'unsupported'}});return;}
if(f.params.configId==='mode')mode=f.params.value;else if(f.params.configId==='model')model=f.params.value;else if(f.params.configId==='EFFORT_ID')effort=f.params.value;result({configOptions:options()});
  if(pendingPrompt && effort==='medium'){
   send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'E2E_RUNNING_FINAL_'+mode+'_'+model+'_'+effort}}}});
   send({id:pendingPrompt.id,result:{stopReason:'end_turn'}});pendingPrompt=undefined;
  }
 }
 else if(f.method==='session/prompt'){
  fs.writeFileSync(promptPath,JSON.stringify((fs.existsSync(promptPath)?JSON.parse(fs.readFileSync(promptPath,'utf8')):0)+1));
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

describe("外部引擎首发前配置与同会话续聊", () => {
  it("两家引擎都先展示配置，首发使用所选模式且续聊复用进程", async () => {
    const bin = process.env.ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN;
    if (!bin || !process.env.PATH?.split(process.platform === "win32" ? ";" : ":").includes(bin))
      throw new Error("需要隔离的官方 CLI 状态夹具 PATH");
    for (const engine of ["claude-code", "codex"] as const) {
      const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
      const root = join(
        resolveE2EStorageRoot(),
        "engines",
        managedAdapterInstallDirName(descriptor),
      );
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
    await prepareV4ConversationE2E({ skipProvider: true });
    for (const [name, engine] of [
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
    ] as const) {
      if (name === "Codex") await startNewV4Draft();
      await $('[data-testid="session-engine-select"]').click();
      await $(`[role="option"]=${name}`).click();
      await $('[data-testid="engine-config-model"]').waitForDisplayed({ timeout: 30000 });
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="engine-config-model"]').getText()).includes(
            `${engine} fixture model`,
          ),
        { timeout: 30000, timeoutMsg: "配置必须属于当前引擎" },
      );
      // 原生 Claude 缺省返回 Manual，客户端须在首发前确认 Auto；Codex 保留原生 Safe。
      expect(await $('[data-testid="engine-config-mode"]').getText()).toBe(
        engine === "claude-code" ? "Auto" : "Safe",
      );
      if (engine === "claude-code") {
        await $('[data-testid="engine-config-mode"]').click();
        await $('[role="menuitemradio"]=Manual').click();
        await browser.waitUntil(
          async () => (await $('[data-testid="engine-config-mode"]').getText()) === "Manual",
          { timeoutMsg: "用户显式选择 Manual 后不能被新会话默认值覆盖" },
        );
      }
      await $('[data-testid="engine-config-mode"]').click();
      await $('[role="menuitemradio"]=Full').click();
      await $('[data-testid="engine-config-model"]').click();
      await $('[data-testid="engine-config-menu-model"]').waitForDisplayed();
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const menu = document.querySelector<HTMLElement>(
              '[data-testid="engine-config-menu-model"]',
            );
            if (!menu) return false;
            const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
            return (
              items.length === 18 &&
              menu.scrollHeight <= menu.clientHeight &&
              items.every((item) => {
                const r = item.getBoundingClientRect();
                return (
                  r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
                );
              })
            );
          }),
        { timeoutMsg: "完整模型目录必须一次可见且无滚动区域" },
      );
      await $(`[role="menuitemradio"]=${engine} fixture model 17`).click();
      const effortId = engine === "codex" ? "reasoning_effort" : "effort";
      await $(`[data-testid="engine-config-${effortId}"]`).click();
      const slider = await $(`[data-testid="engine-effort-slider-${effortId}"]`);
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
        async () => (await $('[data-testid="engine-effort-value"]').getText()) === "High",
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
      await $(rowSelector).moveTo();
      await $(
        `${rowSelector} button[aria-label="Pin task"], ${rowSelector} button[aria-label="置顶任务"]`,
      ).click();
      const unpinSelector = `${rowSelector} button[aria-label="Unpin task"], ${rowSelector} button[aria-label="取消置顶任务"]`;
      await $(unpinSelector).waitForDisplayed();
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
            window as typeof window & { __testActions?: { setTheme?: (value: string) => void } }
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
      await $(unpinSelector).click();
      await browser.waitUntil(async () => !(await $(unpinSelector).isExisting()));
      expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);
      await sendV4Prompt("E2E_EXTERNAL_PREWARM continue");
      await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_full_fixture-17_high_2");
      await waitForV4ConversationState((s) => s.state === "idle", "续聊完成");

      // E14：由配置提交释放受控 prompt，不用固定等待掩盖运行中配置的时序。
      await sendV4Prompt("E2E_EXTERNAL_RUNNING");
      await waitForV4AssistantMessageContaining("E2E_RUNNING_CHECKING");
      const modeControl = $('[data-testid="engine-config-mode"]');
      expect(await modeControl.isEnabled()).toBe(true);
      await modeControl.click();
      await $('[role="menuitemradio"]=Safe').click();
      await $('[data-testid="engine-config-model"]').click();
      await $(`[role="menuitemradio"]=${engine} fixture model 1`).click();
      await $('[data-testid="engine-config-fast"]').click();
      await $('[role="menuitemradio"]=Rejected fast').click();
      await browser.waitUntil(async () =>
        browser.execute(() =>
          /配置修改未生效|Configuration was not changed/.test(document.body.innerText),
        ),
      );
      expect(await $('[data-testid="engine-config-fast"]').getText()).toContain("Off");
      await $(`[data-testid="engine-config-${effortId}"]`).click();
      await browser.keys("ArrowLeft");
      await browser.waitUntil(
        async () => (await $('[data-testid="engine-effort-value"]').getText()) === "Medium",
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
      const terminal = $(`[data-testid="tool-summary-trigger-${engine}-fixture-bash"]`);
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
      const usage = $('[data-testid="chat-context-usage-trigger"]');
      await usage.waitForDisplayed();
      expect(await usage.getAttribute("aria-label")).toContain("1,234");
      expect(await usage.getAttribute("aria-label")).toContain("10,000");
      await $(`[data-testid="tool-summary-trigger-${engine}-fixture-agent"]`).scrollIntoView();
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
      expect(beforeRecovery.session).toMatchObject({ external_session_id: "fixture-session" });
      expect(beforeRecovery.messages.length).toBeGreaterThan(0);
      expect(beforeRecovery.parts.length).toBeGreaterThan(0);
      const promptPath = join(dirname(recoveryPath), "prompt-count.json");
      const promptsBeforeRecovery = JSON.parse(await readFile(promptPath, "utf8"));
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await selectV4TaskById(taskId);
      await waitForV4ComposerText(draft, "冷恢复必须保留未发送草稿");
      await browser.waitUntil(
        async () => {
          const model = $('[data-testid="engine-config-model"]');
          return (
            (await model.isEnabled()) &&
            (await model.getText()).includes(`${engine} fixture model 1`)
          );
        },
        { timeout: 30000, timeoutMsg: "冷恢复必须显示上次选择且已连接原生会话" },
      );
      expect(JSON.parse(await readFile(recoveryPath, "utf8"))).toBe(3);
      expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);
      expect(persistedHistory(taskId)).toEqual(beforeRecovery);
      expect(JSON.parse(await readFile(promptPath, "utf8"))).toBe(promptsBeforeRecovery);
      expect(await $('[data-testid="engine-config-mode"]').getText()).toContain("Safe");
      await $(`[data-testid="engine-config-${effortId}"]`).click();
      await browser.waitUntil(
        async () => (await $('[data-testid="engine-effort-value"]').getText()) === "Medium",
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
        async () => (await $('[data-testid="engine-effort-value"]').getText()) === "High",
      );
      await browser.keys("Escape");
      await setV4ComposerText("");
      await sendV4Prompt("E2E_EXTERNAL_RESTORED");
      await waitForV4AssistantMessageContaining("E2E_ENGINE_REPLY_safe_fixture-1_high_1");
      await waitForV4ConversationState((s) => s.state === "idle", "冷恢复后继续同一会话");
      await browser.saveScreenshot(join(artifactDir, `${engine}-restored-settings.png`));
    }
  });
});
