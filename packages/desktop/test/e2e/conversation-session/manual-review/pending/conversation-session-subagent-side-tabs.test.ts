import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_PANE_SHELL,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
} from "@zcode/shared/test-ids";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  clearAppData,
  setCurrentElectronRendererContentSize,
} from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  getV4FocusedPaneId,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";
import {
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForComposerText,
} from "../../../helpers/conversation-session.js";
import { ensureToolCrossProductFullAccessMode } from "../../../helpers/conversation-session-tool-cross-product.js";

const PARENT_MARKER = "E2E_SUBAGENT_SIDE_TABS_PARENT";
const PARENT_DONE = "E2E_SUBAGENT_SIDE_TABS_PARENT_DONE";
const CHILD_DONE_PREFIX = "E2E_SUBAGENT_SIDE_TABS_CHILD_DONE";
const CHILD_COUNT = 6;
const BACKGROUND_PARENT_MARKER = "E2E_RUNNING_SUBAGENT_SIDE_TAB_PARENT";
const BACKGROUND_LAUNCHED = "E2E_RUNNING_SUBAGENT_SIDE_TAB_LAUNCHED";
const BACKGROUND_PARENT_DONE = "E2E_RUNNING_SUBAGENT_SIDE_TAB_PARENT_DONE";

describe("子智能体右侧 tabs manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("UX10: 会话菜单右移后子任务详情保持身份、正文和焦点scope", async function () {
    this.timeout(180000);
    await setCurrentElectronRendererContentSize(1600, 900);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      "E2E_UX10_SIDE_TABS: launch one Explore Agent with prompt E2E_UX10_DETAIL_CHILD; after its reply, respond UX10_SIDE_TABS_DONE.",
    );
    const parentTab = (await getV4FocusedPaneId())!;
    const open = await $(
      `[data-pane-id="${parentTab}"] [data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
    );
    await open.waitForDisplayed({ timeout: 60000 });
    await open.click();
    const detail = await $('[data-side-pane-tab-id^="subagent-session:"]');
    await detail.waitForDisplayed();
    const detailId = await detail.getAttribute("data-side-pane-tab-id");
    const childId = await browser.execute(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-session-id]")).find((node) =>
          node.dataset.sessionId?.startsWith("sess_subagent_"),
        )?.dataset.sessionId ?? null,
    );
    expect(childId).toBeTruthy();
    await clickUx10LayoutItem(`workbench-activate-tab-${parentTab}`);
    await browser.waitUntil(
      async () => (await readUx10Layout()).groups[1]?.activeTabId === parentTab,
    );
    const moved = await readUx10Layout();
    const draftId = moved.groups[0]!.activeTabId;
    expect(await detail.getAttribute("data-side-pane-tab-id")).toBe(detailId);
    await waitForV4AssistantMessageContaining("UX10_SIDE_TABS_DONE", 90000);
    const child = await $(`[data-session-id="${childId}"]`);
    await browser.waitUntil(async () => (await child.getText()).includes("UX10_DETAIL_CHILD_DONE"));
    await observeUx10ChildScroll(childId!);
    const childLocation = await child.getLocation();
    const initialScroll = await readUx10ChildScroll(childId!);
    await browser
      .action("wheel")
      .scroll({
        x: Math.round(childLocation.x + 60),
        y: Math.round(childLocation.y + 160),
        deltaX: 0,
        deltaY: -400,
        duration: 250,
      })
      .perform();
    await browser.waitUntil(async () => (await readUx10ChildScroll(childId!)) < initialScroll);
    const savedScroll = await readUx10ChildScroll(childId!);
    await clickUx10LayoutItem(`workbench-activate-tab-${draftId}`);
    await browser.waitUntil(async () => !(await detail.isDisplayed()));
    await clickUx10LayoutItem(`workbench-activate-tab-${parentTab}`);
    await detail.waitForDisplayed();
    expect(await detail.getAttribute("data-side-pane-tab-id")).toBe(detailId);
    expect(await child.getText()).toContain("UX10_DETAIL_CHILD_DONE");
    try {
      await browser.waitUntil(async () => (await readUx10ChildScroll(childId!)) === savedScroll, {
        timeout: 10000,
        timeoutMsg: `UX10 子任务详情焦点往返后未恢复实际滚动 ${savedScroll}`,
      });
    } finally {
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        const events = await browser.execute(
          () => (window as unknown as { __ux10ScrollEvents: unknown[] }).__ux10ScrollEvents,
        );
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-child-scroll.json"),
          JSON.stringify(
            {
              childId,
              detailId,
              initialScroll,
              savedScroll,
              finalScroll: await readUx10ChildScroll(childId!),
              events,
            },
            null,
            2,
          ),
        );
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-child-scroll.png"),
        );
      }
    }
    expect((await readUx10Layout()).groups).toEqual(moved.groups);
    expect(await countVisibleSubagentTabs()).toBe(1);
    if (process.env.ZCODE_E2E_ARTIFACT_DIR)
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-subagent-scope-retained.png"),
      );
  });

  it("SAT12: Running subagent 摘要行复用 child 右侧 tab", async function () {
    this.timeout(240000);

    await prepareConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const prompt = [
      `${BACKGROUND_PARENT_MARKER}_${runId}: launch exactly one Agent with run_in_background true.`,
      `The child must run Bash command "sleep 20", then reply with exactly CHILD_BACKGROUND_DONE_${runId}.`,
      `After the background launch tool returns, reply with exactly ${BACKGROUND_LAUNCHED}_${runId} without waiting.`,
      `After its task notification arrives, reply with exactly ${BACKGROUND_PARENT_DONE}_${runId}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "Running subagent side-tab 首发后输入框没有清空");
    await waitForAssistantMessageContaining(`${BACKGROUND_LAUNCHED}_${runId}`);
    await waitForRunningSubagentTrigger(90000);

    await clickRunningSubagentTrigger();
    await waitForVisibleSubagentTabCount(1, 30000);
    await clickRunningSubagentTrigger();
    expect(await countVisibleSubagentTabs()).toBe(1);

    await waitForAssistantMessageContaining(`${BACKGROUND_PARENT_DONE}_${runId}`);
  });

  it("SAT01-SAT03: 6 个 running child 使用右侧 tabs 且打开后持续更新", async function () {
    this.timeout(240000);

    await prepareConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const prompt = [
      `${PARENT_MARKER}_${runId}: In one assistant turn launch exactly ${CHILD_COUNT} foreground Agent tool calls in parallel.`,
      `Use subagent_type "general-purpose" for every child.`,
      `Give child N this exact instruction: run Bash command "sleep 6", then reply with exactly ${CHILD_DONE_PREFIX}_N_${runId}.`,
      `Do not finish the parent response until every child completes; then reply with exactly ${PARENT_DONE}_${runId}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "subagent side tabs 首发后输入框没有清空");
    await waitForSubagentSummaryActions(CHILD_COUNT, 90000);
    await expectSubagentSummariesToOpenSidePaneDirectly();

    const initialRowCounts = await openAllSubagentTabs();
    expect(initialRowCounts).toHaveLength(CHILD_COUNT);
    await waitForVisibleSubagentTabCount(CHILD_COUNT, 30000);
    expect(await countWorkbenchPanes()).toBe(1);

    await clickFirstSubagentSummaryAction();
    expect(await countVisibleSubagentTabs()).toBe(CHILD_COUNT);

    await browser.waitUntil(
      async () => {
        const current = await readChildTimelineRowCounts();
        return (
          current.length === CHILD_COUNT &&
          current.every((count, index) => count > (initialRowCounts[index] ?? 0))
        );
      },
      {
        timeout: 120000,
        timeoutMsg: "已打开的 child tabs 没有在运行中继续增加 timeline rows",
      },
    );

    await waitForAssistantMessageContaining(`${PARENT_DONE}_${runId}`);
  });
});

async function readUx10Layout() {
  return browser.execute(
    () =>
      JSON.parse(localStorage.getItem("zcode-conversation-workbench:v1")!) as {
        groups: Array<{ id: string; tabIds: string[]; activeTabId: string }>;
      },
  );
}

async function readUx10ChildScroll(id: string) {
  return browser.execute(
    (sessionId) =>
      document.querySelector<HTMLElement>(
        `[data-session-id="${sessionId}"] [data-testid="v4-timeline"]`,
      )?.scrollTop ?? -1,
    id,
  );
}

async function observeUx10ChildScroll(id: string) {
  await browser.execute((sessionId) => {
    const selector = `[data-session-id="${sessionId}"]`;
    const child = document.querySelector(selector)!;
    const scroll = child.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;
    const events: unknown[] = [];
    (window as unknown as { __ux10ScrollEvents: unknown[] }).__ux10ScrollEvents = events;
    const record = (event: string) =>
      events.push({
        at: performance.now(),
        event,
        scrollTop: scroll.scrollTop,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        clientWidth: scroll.clientWidth,
        mounted: scroll.isConnected,
        sameChild: document.querySelector(selector) === child,
        sameScroll: document.querySelector(`${selector} [data-testid="v4-timeline"]`) === scroll,
        following: scroll.dataset.following,
      });
    scroll.addEventListener("scroll", () => record("scroll"));
    new ResizeObserver(() => record("resize")).observe(scroll);
    record("start");
  }, id);
}

async function clickUx10LayoutItem(id: string) {
  const trigger = await $('[data-testid="workbench-layout-menu"]');
  await trigger.click();
  const item = await $(`[data-testid="${id}"]`);
  await item.waitForDisplayed();
  await item.click();
  await browser.waitUntil(async () => (await trigger.getAttribute("data-state")) !== "open");
}

async function waitForSubagentSummaryActions(expected: number, timeout: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (prefix) => document.querySelectorAll(`[data-testid^="${prefix}-"]`).length >= expected,
        TID_V4_SUBAGENT_OPEN_SIDE_PANE,
      ),
    {
      timeout,
      timeoutMsg: `没有等到 ${expected} 个 subagent 摘要直开入口`,
    },
  );
}

async function waitForRunningSubagentTrigger(timeout: number): Promise<void> {
  // 修复原因：面板 test id 来自 shared 常量；旧代码误传了只存在于浏览器回调
  // 形参里的同名变量，导致 E2E TypeScript 编译阶段直接失败。
  await browser.waitUntil(
    async () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        if (panel?.dataset.state === "collapsed") {
          panel.querySelector<HTMLButtonElement>("button")?.click();
        }
        const runningSection = panel?.querySelector<HTMLButtonElement>(
          '[data-status-section-trigger="agent"]',
        );
        if (runningSection?.getAttribute("aria-expanded") === "false") {
          runningSection.click();
        }
        return Boolean(panel?.querySelector('[data-running-subagent-session-trigger="true"]'));
      }, TID_CHAT_SUMMARY_PANEL),
    {
      timeout,
      timeoutMsg: "右上角智能体区块没有出现可打开的 subagent session 行",
    },
  );
}

async function clickRunningSubagentTrigger(): Promise<void> {
  await browser.execute(() => {
    document
      .querySelector<HTMLButtonElement>('[data-running-subagent-session-trigger="true"]')
      ?.click();
  });
}

async function expectSubagentSummariesToOpenSidePaneDirectly(): Promise<void> {
  const summaries = await browser.execute(
    (prefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map(
        (summary) => ({
          ariaExpanded: summary.getAttribute("aria-expanded"),
          hasChevron: Boolean(summary.querySelector(".lucide-chevron-right")),
          hasInlineDetails: Boolean(
            summary.parentElement?.querySelector('[data-slot="collapsible-content"]'),
          ),
        }),
      ),
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  );

  expect(summaries).toHaveLength(CHILD_COUNT);
  expect(summaries.every((summary) => summary.ariaExpanded === null)).toBe(true);
  expect(summaries.every((summary) => !summary.hasChevron)).toBe(true);
  expect(summaries.every((summary) => !summary.hasInlineDetails)).toBe(true);
}

async function openAllSubagentTabs(): Promise<number[]> {
  await browser.execute(
    (prefix, expected) => {
      const summaries = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`),
      ).slice(0, expected);
      for (const summary of summaries) summary.click();
    },
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    CHILD_COUNT,
  );
  await waitForVisibleSubagentTabCount(CHILD_COUNT, 30000);
  return readChildTimelineRowCounts();
}

async function clickFirstSubagentSummaryAction(): Promise<void> {
  await browser.execute((prefix) => {
    document.querySelector<HTMLElement>(`[data-testid^="${prefix}-"]`)?.click();
  }, TID_V4_SUBAGENT_OPEN_SIDE_PANE);
}

async function waitForVisibleSubagentTabCount(expected: number, timeout: number): Promise<void> {
  await browser.waitUntil(async () => (await countVisibleSubagentTabs()) === expected, {
    timeout,
    timeoutMsg: `右侧没有出现 ${expected} 个 subagent tabs`,
  });
}

async function countVisibleSubagentTabs(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-side-pane-tab-id^="subagent-session:"]').length,
  );
}

async function countWorkbenchPanes(): Promise<number> {
  return browser.execute(
    (testId) => document.querySelectorAll(`[data-testid^="${testId}"]`).length,
    TID_V4_PANE_SHELL,
  );
}

async function readChildTimelineRowCounts(): Promise<number[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-session-id^="sess_subagent_"]'))
      .map((pane) =>
        Number(
          pane.querySelector<HTMLElement>('[data-testid="v4-timeline"]')?.dataset.rowCount ?? 0,
        ),
      )
      .sort((left, right) => left - right),
  );
}
