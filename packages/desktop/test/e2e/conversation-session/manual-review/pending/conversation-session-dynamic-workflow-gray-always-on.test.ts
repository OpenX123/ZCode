import { readFile } from "node:fs/promises";
import { clearAppData, waitForTestIdByDom } from "../../../helpers/desktop-app.js";
import {
  getV4SlashOptionIds,
  prepareV4ConversationE2E,
  waitForV4SlashOption,
} from "../../../helpers/v4-conversation.js";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_GOAL_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  openAutomationsPage,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  configureLocalDynamicWorkflowMode,
  readPlusMenuAddOptionIds,
  setComposerDraft,
} from "../../../helpers/dynamic-workflow-gray.js";

// DWG-08：本地用户选择决定三个工作流入口；不访问官方配置服务。
// E2E_DWF_GRAY：只验证入口，不发送模型请求，沿用原有case标识。
describe("动态工作流本地始终开启（alwaysOn）", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await configureLocalDynamicWorkflowMode("alwaysOn");
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

  it("DWG-08 命中时 + 菜单、/ 面板与自动化页都提供工作流入口", async function () {
    this.timeout(180000);

    // 1) `/` 面板：workflow 在场，并按产品要求紧随 goal（APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 的顺序）。
    //    先用 goal 当 catalog 屏障，再在同一个面板里等 workflow 到齐，不重复改写草稿。
    await openSlashPanelWithCatalogReady();
    await waitForV4SlashOption(SLASH_WORKFLOW_OPTION_ID, 60000);
    const slashIds = await getV4SlashOptionIds();
    expect(slashIds.indexOf(SLASH_WORKFLOW_OPTION_ID)).toBe(
      slashIds.indexOf(SLASH_GOAL_OPTION_ID) + 1,
    );
    await closeSlashPanel();

    // 2) `+` 菜单：工作流在场且排在目标之后。
    await setComposerDraft("");
    await openPlusMenu();
    await $(`[data-trigger="+"] [data-option-id="${PLUS_WORKFLOW_OPTION_ID}"]`).waitForDisplayed();
    const addIds = await readPlusMenuAddOptionIds();
    expect(addIds.indexOf(PLUS_WORKFLOW_OPTION_ID)).toBe(addIds.indexOf(PLUS_GOAL_OPTION_ID) + 1);
    await closePlusMenu();

    // 3) 自动化页：标题即切换，「自动化 / 工作流」两个标签都在场。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(automationsPageTabTestId("automation"), {
      timeout: 30000,
      timeoutMsg: "自动化页标题没有「自动化」切换",
    });
  });
});
