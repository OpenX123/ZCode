import { readFile } from "node:fs/promises";
import { TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { clearAppData, readSettings, waitForTestIdByDom } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E, startNewV4Draft } from "../../../helpers/v4-conversation.js";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_GOAL_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  expectTestIdAbsentThroughout,
  hasTestIdInDom,
  openAutomationsPage,
  openDynamicWorkflowModeSelect,
  openGeneralSettings,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  configureLocalDynamicWorkflowMode,
  readDynamicWorkflowModeTriggerText,
  readPlusMenuAddOptionIds,
  selectDynamicWorkflowMode,
  setComposerDraft,
} from "../../../helpers/dynamic-workflow-gray.js";
import { sel } from "../../../helpers/selectors.js";

// DWG-08：本地用户选择决定三个工作流入口；不访问官方配置服务。
// E2E_DWF_GRAY：只验证入口，不发送模型请求，沿用原有case标识。
describe("动态工作流本地关闭（disabled）", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await configureLocalDynamicWorkflowMode("disabled");
  });
  afterEach(async () => {
    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!capturePath) throw new Error("Missing provider capture evidence");
    expect(JSON.parse(await readFile(capturePath, "utf8")).records).toEqual([]);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWG-08 关闭时 + 菜单、/ 面板与自动化页都没有工作流入口", async function () {
    this.timeout(180000);

    // 1) `/` 面板：catalog 已送达（goal 在场）但 workflow 被整条剔除。
    const slashIds = await openSlashPanelWithCatalogReady();
    expect(slashIds).toContain(SLASH_GOAL_OPTION_ID);
    expect(slashIds).not.toContain(SLASH_WORKFLOW_OPTION_ID);
    await closeSlashPanel();

    // 2) `+` 菜单：目标仍在（正向对照），工作流不在。菜单打开瞬间快照 catalog，
    //    上一步的屏障保证这里读到的是已送达的目录。
    await setComposerDraft("");
    await openPlusMenu();
    const addIds = await readPlusMenuAddOptionIds();
    expect(addIds).toContain(PLUS_GOAL_OPTION_ID);
    expect(addIds).not.toContain(PLUS_WORKFLOW_OPTION_ID);
    await closePlusMenu();

    // 3) 自动化页：页面渲染了，但标题退回平铺 h1——两个标签按钮都不在场，
    //    并且在观察窗内不会迟到出现。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    expect(await hasTestIdInDom(automationsPageTabTestId("workflow"))).toBe(false);
    expect(await hasTestIdInDom(automationsPageTabTestId("automation"))).toBe(false);
    await expectTestIdAbsentThroughout(automationsPageTabTestId("workflow"));
  });

  it("DWG-23 用户关闭时设置行照样出现，选「始终开启」后工作流入口回来", async function () {
    this.timeout(240000);

    // 本地选择为关闭；固定默认值仍是 onDemand。
    await openGeneralSettings();
    await browser.waitUntil(
      async () => (await readDynamicWorkflowModeTriggerText()).includes("关闭"),
      { timeout: 30000, timeoutMsg: "用户关闭时动态工作流模式行没有出现或没有显示「关闭」" },
    );
    await openDynamicWorkflowModeSelect();
    const itemText = (mode: string) =>
      $(sel(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode))).getText();
    expect(await itemText("disabled")).not.toContain("默认");
    expect(await itemText("onDemand")).toContain("默认");
    expect(await itemText("alwaysOn")).not.toContain("默认");
    await browser.keys("Escape");

    // 2) 选「始终开启」：不等于默认值，所以原样写进设置文件。
    await selectDynamicWorkflowMode("alwaysOn");
    await browser.waitUntil(async () => (await readSettings()).dynamicWorkflowMode === "alwaysOn", {
      timeout: 15000,
      timeoutMsg: "选择「始终开启」没有写进设置文件",
    });

    // 3) 自动化页恢复「工作流」切换：renderer 快照已按用户选择重读。
    await openAutomationsPage();
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "选「始终开启」后自动化页没有出现「工作流」切换",
    });

    // 4) 新草稿的 + 菜单出现「工作流」：Host 已按用户选择给 CLI 重发 enabled:true 的策略。
    await startNewV4Draft();
    await setComposerDraft("");
    await browser.waitUntil(
      async () => {
        await openPlusMenu();
        const ids = await readPlusMenuAddOptionIds();
        await closePlusMenu();
        return ids.includes(PLUS_GOAL_OPTION_ID) && ids.includes(PLUS_WORKFLOW_OPTION_ID);
      },
      { timeout: 30000, timeoutMsg: "选「始终开启」后新草稿的 + 菜单仍没有工作流" },
    );
  });
});
