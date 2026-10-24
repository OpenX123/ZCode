import {
  TID_AUTOMATIONS_PAGE_TAB,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import {
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  readSettings,
  waitForDefaultWorkspaceReady,
} from "./desktop-app.js";
import { sel } from "./selectors.js";
import { getV4SlashOptionIds, hasV4SlashPanel } from "./v4-conversation.js";
// 动态工作流入口和设置的共享测试原语；所有模式由本地设置与 Host 裁决。
// 历史文件名保持不变，避免改动既有 pending case 的引用路径。

/** 输入框 `+` 面板（ChatPromptActionMenu）的容器选择器，与 PLUS 用例同源。 */
export const PLUS_MENU_PANEL_SELECTOR = '[data-trigger="+"]';

/** `/` 面板里目标命令的候选项 id；本地模式关闭也必须在场，是 catalog 已送达的正向对照。 */
export const SLASH_GOAL_OPTION_ID = "slash:goal";
/** `/` 面板里工作流命令的候选项 id；本地模式关闭时整条被剔除。 */
export const SLASH_WORKFLOW_OPTION_ID = "slash:workflow";
/** `+` 面板里目标 / 工作流两个「添加」项的 option id。 */
export const PLUS_GOAL_OPTION_ID = "add-goal";
export const PLUS_WORKFLOW_OPTION_ID = "add-workflow";

/** 自动化页内容容器；本地两档都在场，用来把「页面没渲染」和「标签不在场」区分开。 */
export const AUTOMATIONS_CONTENT_SELECTOR = "[data-automations-content]";

export function automationsPageTabTestId(tab: "automation" | "workflow"): string {
  return testId(TID_AUTOMATIONS_PAGE_TAB, tab);
}

export async function setComposerDraft(text: string): Promise<void> {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    stabilizeLexicalCaretAtEnd: true,
  });
}

/**
 * 打开 `/` 面板并等 CLI catalog 送达：等的是 `goal`，它不受工作流模式影响，两档都必然出现。
 * 用它当屏障，后面对 `workflow` 的在场 / 缺席断言才不会退化成「catalog 还没到」。
 */
export async function openSlashPanelWithCatalogReady(timeout = 30000): Promise<string[]> {
  await setComposerDraft("/");
  await browser.waitUntil(
    async () =>
      (await hasV4SlashPanel()) && (await getV4SlashOptionIds()).includes(SLASH_GOAL_OPTION_ID),
    {
      timeout,
      timeoutMsg: `slash 面板没有出现 catalog 屏障候选项: ${SLASH_GOAL_OPTION_ID}`,
    },
  );
  return await getV4SlashOptionIds();
}

export async function closeSlashPanel(): Promise<void> {
  await browser.keys("Escape");
  await setComposerDraft("");
}

/** 空草稿下打开 `+` 面板。菜单在打开瞬间快照 catalog，调用前必须先等 catalog 就绪。 */
export async function openPlusMenu(): Promise<void> {
  await clickTestIdByDom(TID_CHAT_ATTACHMENT_BUTTON, {
    timeoutMsg: "输入框没有出现 + 入口",
  });
  await $(PLUS_MENU_PANEL_SELECTOR).waitForDisplayed();
}

export async function closePlusMenu(): Promise<void> {
  await browser.keys("Escape");
  await $(PLUS_MENU_PANEL_SELECTOR).waitForDisplayed({ reverse: true });
}

/** `+` 面板里全部「添加」项的 option id，按 DOM 顺序。 */
export async function readPlusMenuAddOptionIds(): Promise<string[]> {
  return await browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll(`${selector} [data-option-id^="add-"]`)).map(
        (element) => element.getAttribute("data-option-id") ?? "",
      ),
    PLUS_MENU_PANEL_SELECTOR,
  );
}

/** 复用设置返回的自动化页，或从可见侧栏进入，并等待页面内容。 */
export async function openAutomationsPage(): Promise<void> {
  if (await $(sel(TID_SETTINGS_PAGE)).isDisplayed()) {
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    // 设置返回原页面；从自动化页进入设置时不会出现 coding composer。
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ reverse: true, timeout: 30000 });
  }
  await waitForLocalDynamicWorkflowPolicy();
  if (!(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed())) {
    await clickTestIdByWebDriver(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现自动化入口",
    });
  }
  await $(AUTOMATIONS_CONTENT_SELECTOR).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "自动化页内容没有渲染",
  });
}

/** 磁盘写入早于 Host 同步；等待当前工作区 CLI 已应用模式，避免读取旧目录。 */
async function waitForLocalDynamicWorkflowPolicy(): Promise<void> {
  const mode = (await readSettings()).dynamicWorkflowMode ?? "onDemand";
  await browser.waitUntil(
    async () =>
      browser.execute((workflowEnabled) => {
        const host = window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
          __zcodeSessionStoreE2E?: {
            getState(): {
              getWorkspaceState?: (path: string) => {
                slashCommands?: Array<{ name: string }>;
              };
            };
          };
        };
        const path = host.__zcodeTabStoreE2E?.getState().activeWorkspacePath;
        if (!path) return false;
        const commands = host.__zcodeSessionStoreE2E
          ?.getState()
          .getWorkspaceState?.(path).slashCommands;
        if (!commands) return false;
        const names = commands.map(({ name }) => name.trim().replace(/^\/+/, ""));
        return names.includes("goal") && names.includes("workflow") === workflowEnabled;
      }, mode !== "disabled"),
    { timeout: 30000, timeoutMsg: `CLI 工作流目录没有应用本地模式: ${mode}` },
  );
}

export function hasTestIdInDom(target: string): Promise<boolean> {
  return browser.execute(
    (current) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
        (element) => element.dataset.testid === current,
      ),
    target,
  );
}

/**
 * 在一段观察窗内持续断言某个 test id 不出现。
 * 本地模式关闭是「不在场」断言：一次性快照无法把「关掉了」和「还没渲染出来」分开，
 * 必须在屏障之后再观察一段时间，确认它不会迟到。
 */
export async function expectTestIdAbsentThroughout(
  target: string,
  { windowMs = 3000, intervalMs = 200 }: { windowMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (await hasTestIdInDom(target)) {
      throw new Error(`本地模式关闭时不应出现的 test id 迟到出现: ${target}`);
    }
    await browser.pause(intervalMs);
  }
}

/** 打开设置 › 常规（动态工作流模式行所在的分区，launch.md「The user's choice」）。 */
export async function openGeneralSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现常规分区入口",
  });
}

/** 打开模式下拉并读出每个选项是否带「默认」标签（按选项的 test id 后缀）。 */
export async function openDynamicWorkflowModeSelect(): Promise<void> {
  await clickTestIdByWebDriver(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER, {
    timeout: 15000,
    timeoutMsg: "动态工作流模式下拉触发器没有出现",
  });
  await $(sel(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, "alwaysOn"))).waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "动态工作流模式下拉没有展开",
  });
}

export async function selectDynamicWorkflowMode(mode: DynamicWorkflowMode): Promise<void> {
  await openDynamicWorkflowModeSelect();
  await clickTestIdByDom(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode), {
    timeout: 15000,
    timeoutMsg: `动态工作流模式选项没有出现: ${mode}`,
  });
}

export function readDynamicWorkflowModeTriggerText(): Promise<string> {
  return $(sel(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER)).getText();
}

/** 使用真实设置 UI 建立本地模式前置，并等待磁盘和 CLI 工作流目录收敛。 */
export async function configureLocalDynamicWorkflowMode(mode: DynamicWorkflowMode): Promise<void> {
  await openGeneralSettings();
  await selectDynamicWorkflowMode(mode);
  await browser.waitUntil(
    async () => ((await readSettings()).dynamicWorkflowMode ?? "onDemand") === mode,
    { timeout: 15000, timeoutMsg: `动态工作流本地设置没有保存: ${mode}` },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await waitForDefaultWorkspaceReady(30000);
  await waitForLocalDynamicWorkflowPolicy();
}
