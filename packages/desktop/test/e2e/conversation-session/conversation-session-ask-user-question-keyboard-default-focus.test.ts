import { clearAppData } from "../helpers/desktop-app.js";
import { TID_V4_MODEL_CONFIG, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { UPSTREAM_MODEL_VALUES } from "../helpers/upstream-provider.js";
import {
  countUpstreamRequests,
  waitForUpstreamRequest,
} from "../helpers/conversation-session-network.js";
import { waitForToolCallBlockByToolName } from "../helpers/conversation-session-tool.js";
import {
  getV4FocusedPaneId,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const MARKER_EMPTY_SUBMIT = "E2E_ADF_EMPTY_SUBMIT";
const MARKER_TAB_ENTER = "E2E_ADF_TAB_ENTER";
const MARKER_ENTER_SKIP = "E2E_ADF_ENTER_SKIP";
const MARKER_MULTISELECT = "E2E_ADF_MULTISELECT";
const MARKER_ESCAPE_DISMISS = "E2E_ADF_ESCAPE_DISMISS";

const Q1_SINGLE = "E2E_ADF_Q1_SINGLE_SELECT";
const Q2_MULTI = "E2E_ADF_Q2_MULTI_SELECT";

const Q1_OPT_A = "E2E_ADF_Q1_A";
const Q1_OPT_B = "E2E_ADF_Q1_B";
const Q2_OPT_A = "E2E_ADF_Q2_A";
const Q2_OPT_B = "E2E_ADF_Q2_B";
const Q2_OPT_C = "E2E_ADF_Q2_C";
let providerReady = false;

async function prepareQuestionCase() {
  // 已隐藏的旧会话保留 toolbar，通用 provider helper 的首个匹配不等于当前草稿。
  // 同 spec 仅在首次真实初始化成功后复用；单独筛选任一 case 仍会完整初始化。
  await prepareV4ConversationE2E({ skipProvider: providerReady });
  const paneId = await getV4FocusedPaneId();
  if (!paneId) throw new Error("准备完成后没有当前焦点 pane");
  await browser.waitUntil(
    async () => {
      const config = await browser.execute(
        (paneTestId, configTestId) => {
          // 外层 pane shell 同样有 data-pane-id，只有 session pane 拥有 data-session-id。
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
          const anchor = pane?.querySelector<HTMLElement>(`[data-testid="${configTestId}"]`);
          return { sessionId: pane?.dataset.sessionId, model: anchor?.dataset.model };
        },
        testId(TID_V4_SESSION_PANE, paneId),
        TID_V4_MODEL_CONFIG,
      );
      return config.sessionId === "draft" && UPSTREAM_MODEL_VALUES.includes(config.model ?? "");
    },
    {
      timeout: 10000,
      timeoutMsg: "当前 draft 未保留已实际选择的回放模型，不能跳过 provider 初始化",
    },
  );
  providerReady = true;
}

describe("AskUserQuestion 默认无焦点键盘导航 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  // Q15: 弹窗打开无预选 → 鼠标点 Submit → 提交空答案
  it("弹窗打开无预聚焦，鼠标点 Submit 提交空答案", async function () {
    this.timeout(180000);

    // Bug 根因：该 case 转正后仍使用 legacy conversation harness，
    // formal 证据无法确保操作的是当前 V4 pane。
    await prepareQuestionCase();

    const runId = Date.now();
    const prompt = [
      `${MARKER_EMPTY_SUBMIT}_${runId}: Trigger AskUserQuestion with one single-select question.`,
      `Question "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_EMPTY_SUBMIT}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    // 确认弹窗出现且无选项高亮
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // 直接点 Submit
    await clickPrimaryAction();

    // 确认提交了空答案
    await waitForUpstreamRequest(
      {
        includes: [`${MARKER_EMPTY_SUBMIT}_${runId}`, "toolu_e2e_adf_empty_submit"],
      },
      "空答案提交后 Agent 没有收到回复",
      60000,
    );
  });

  // Q18: Tab → 第一项聚焦 → Enter 仅选择 → 显式继续/发送
  it("无预聚焦时按 Tab 聚焦第一项，Enter 只选择，显式按钮推进", async function () {
    this.timeout(180000);

    await prepareQuestionCase();

    const runId = Date.now();
    const prompt = [
      `${MARKER_TAB_ENTER}_${runId}: Trigger AskUserQuestion with two questions.`,
      `Q1 single-select "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      `Q2 single-select "${Q2_MULTI}" with options "${Q2_OPT_A}" and "${Q2_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_TAB_ENTER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    // 确认无预选
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // Tab → 第一项聚焦
    await browser.keys("Tab");
    await expectActiveOption(Q1_OPT_A);

    // Enter → 只选择，显式继续才进入 Q2
    await browser.keys("Enter");
    await waitForElicitationPage("1 / 2", Q1_SINGLE);
    await clickPrimaryAction();
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Q2 也是无预选（切题后普通问答不预聚焦）。
    await expectNoOptionPreSelected();

    // 初始 ArrowDown 与 Tab 同样从卡片焦点启动，聚焦第一项但不选中。
    await browser.keys("ArrowDown");
    await expectActiveOption(Q2_OPT_A);
    await expectOptionSelected(Q2_OPT_A, false);
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);
    await clickPrimaryAction();

    await waitForUpstreamRequest(
      { includes: [`${MARKER_TAB_ENTER}_${runId}`, Q1_OPT_A, Q2_OPT_A] },
      "Tab+Enter 选择结果没有进入下一次模型请求",
      60000,
    );
  });

  // Q19: 卡片 Enter 不推进，显式继续可留空导航
  it("卡片 Enter 不推进，显式继续可留空，Escape 只收起", async function () {
    this.timeout(180000);

    await prepareQuestionCase();

    const runId = Date.now();
    const prompt = [
      `${MARKER_ENTER_SKIP}_${runId}: Trigger AskUserQuestion with two single-select questions.`,
      `Q1 "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      `Q2 "${Q2_MULTI}" with options "${Q2_OPT_A}" and "${Q2_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_ENTER_SKIP}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // 卡片 Enter 不导航；下一题按钮才允许留空导航。
    await browser.keys("Enter");
    await waitForElicitationPage("1 / 2", Q1_SINGLE);
    await clickPrimaryAction();
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Q22：后续题 Escape 只收起，可重开后用显式上一题回改。
    await expectNoOptionPreSelected();
    await browser.keys("Escape");
    await $('[data-elicitation-waiting="true"]').waitForDisplayed();
    await $('[data-elicitation-waiting="true"] button:last-child').click();
    await $('[aria-label="上一题"],[aria-label="Previous question"]').click();
    await waitForElicitationPage("1 / 2", Q1_SINGLE);
    await expectNoOptionPreSelected();

    // 再次显式继续留空，证明返回没有隐式写入第一项。
    await clickPrimaryAction();
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Tab → Enter 只选中 Q2 第一项，再显式发送。
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPT_A);
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);
    await clickPrimaryAction();

    await waitForUpstreamRequest(
      {
        includes: [`${MARKER_ENTER_SKIP}_${runId}`, "toolu_e2e_adf_enter_skip", Q2_OPT_A],
      },
      "Q1 跳过 + Q2 Enter 选中后没有进入模型请求",
      60000,
    );
  });

  // Q20: 多选题 Space/Enter 勾选，显式发送确认
  it("多选题 Space/Enter 只勾选取消，显式发送才提交", async function () {
    this.timeout(180000);

    await prepareQuestionCase();

    const runId = Date.now();
    const prompt = [
      `${MARKER_MULTISELECT}_${runId}: Trigger AskUserQuestion with one multi-select question.`,
      `Multi-select question "${Q2_MULTI}"`,
      `with options "${Q2_OPT_A}", "${Q2_OPT_B}", "${Q2_OPT_C}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_MULTISELECT}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationVisible(Q2_MULTI);
    await expectNoOptionSelected();

    // Tab 聚焦第一项
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPT_A);

    // Space 勾选 Q2_OPT_A
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_A, true);

    // ArrowDown 移到 Q2_OPT_B
    await browser.keys("ArrowDown");
    // Space 勾选 Q2_OPT_B
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, true);

    // ArrowDown 移到 Q2_OPT_C，Space 勾选
    await browser.keys("ArrowDown");
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_C, true);

    // ArrowUp 回到 Q2_OPT_B，Space 取消勾选
    await browser.keys("ArrowUp");
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, false);

    // Enter 也只勾选当前项，不能提交；再取消 B 后显式发送。
    await browser.keys("Enter");
    await expectOptionChecked(Q2_OPT_B, true);
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, false);
    await clickPrimaryAction();

    await waitForUpstreamRequest(
      { includes: [`${MARKER_MULTISELECT}_${runId}`, Q2_OPT_A, Q2_OPT_C] },
      "多选 Space + Enter 结果没有进入模型请求",
      60000,
    );
  });

  // Q22: Escape 只收起，重开后的独立忽略才 decline
  it("首题 Escape 只收起，重开后独立忽略才 decline", async function () {
    this.timeout(180000);

    await prepareQuestionCase();

    const runId = Date.now();
    const prompt = [
      `${MARKER_ESCAPE_DISMISS}_${runId}: Trigger AskUserQuestion with one single-select question.`,
      `Question "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      "Do not answer. Stop if the user dismisses the question.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_ESCAPE_DISMISS}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    await browser.keys("Escape");
    await $('[data-elicitation-waiting="true"]').waitForDisplayed();
    expect(await countUpstreamRequests({ includes: ["toolu_e2e_adf_escape_dismiss"] })).toBe(0);
    await $('[data-elicitation-waiting="true"] button:last-child').click();
    await waitForElicitationVisible(Q1_SINGLE);
    await $('[data-elicitation-dialog-footer="true"] button:first-child').click();
    await waitForElicitationClosed();
    // 修复原因：负向 1200ms 抓包计数依赖 artifact 写盘时机，单跑可能在请求已经
    // 发出时仍读取旧文件而假绿。当前产品合同是独立忽略关闭 UI，并把 declined
    // tool_result 交给模型收口；用 case-local final fixture 对该请求做正向取证。
    await waitForUpstreamRequest(
      {
        includes: [
          `${MARKER_ESCAPE_DISMISS}_${runId}`,
          "toolu_e2e_adf_escape_dismiss",
          "AskUserQuestion was declined",
        ],
      },
      "重开并忽略后 declined tool_result 没有进入模型收口请求",
      60000,
    );
    await waitForV4TimelineContaining("E2E_ADF_ESCAPE_DISMISS_ACK", 60000);
  });
});

// --- helpers ---

interface ElicitationKeyboardSnapshot {
  activeText: string;
  bodyText: string;
  cardFocused: boolean;
  pageText: string | null;
  selectedTexts: string[];
  visible: boolean;
}

async function waitForElicitationVisible(questionContains: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.visible && latest.bodyText.includes(questionContains);
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 弹窗没有出现或内容不包含 "${questionContains}"`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗没有出现; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function waitForElicitationPage(pageText: string, questionContains: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return (
          latest.visible &&
          latest.pageText === pageText &&
          latest.bodyText.includes(questionContains)
        );
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 没有进入目标题目 ${pageText} ${questionContains}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 没有进入目标题目; expected=${pageText}/${questionContains}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectNoOptionPreSelected() {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.cardFocused && latest.activeText === "" && latest.selectedTexts.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 弹窗不应有预选选项",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗不应有预选选项; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function expectNoOptionSelected() {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.selectedTexts.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 弹窗不应有已选选项",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗不应有已选选项; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function expectActiveOption(optionText: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.activeText.includes(optionText);
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 当前焦点选项不是 "${optionText}"`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 当前焦点选项不是 "${optionText}"; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectOptionChecked(optionText: string, checked: boolean) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        const isSelected = latest.selectedTexts.some((t) => t.includes(optionText));
        return isSelected === checked;
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 勾选状态不符合预期; option=${optionText} expectedChecked=${checked}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 勾选状态不符合预期; option=${optionText} expectedChecked=${checked}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectOptionSelected(optionText: string, selected: boolean) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        const isSelected = latest.selectedTexts.some((text) => text.includes(optionText));
        return isSelected === selected;
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 单选状态不符合预期; option=${optionText} expectedSelected=${selected}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 单选状态不符合预期; option=${optionText} expectedSelected=${selected}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function clickPrimaryAction() {
  const button = await $('[data-elicitation-dialog-footer="true"] button:last-child');
  await button.waitForDisplayed({ timeout: 10000 });
  await button.click();
}

async function waitForElicitationClosed() {
  await browser.waitUntil(
    async () =>
      !(await browser.execute(() =>
        Boolean(document.querySelector('[data-elicitation-dialog-card="true"]')),
      )),
    {
      timeout: 10000,
      timeoutMsg: "AskUserQuestion 弹窗没有在 Escape 后关闭",
    },
  );
}

function getElicitationKeyboardSnapshot(): Promise<ElicitationKeyboardSnapshot> {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
    const focused = document.activeElement as HTMLElement | null;
    const card = document.querySelector<HTMLElement>('[data-elicitation-dialog-card="true"]');
    // 修复原因：roving tabindex 会在卡片聚焦时仍给第一项 tabindex=0；只有
    // document.activeElement 才能证明选项获得了真实键盘焦点。
    const activeOption = focused?.closest<HTMLElement>('button[role="option"],[role="checkbox"]');
    const pageText =
      normalizeText(body?.innerText)
        .match(/\b\d+\s*\/\s*\d+\b/)?.[0]
        ?.replace(/\s+/g, " ") ?? null;
    const selectedTexts = Array.from(
      body?.querySelectorAll<HTMLElement>(
        'button[role="option"][aria-selected="true"],[role="checkbox"][aria-checked="true"]',
      ) ?? [],
    ).map((element) => normalizeText(element.innerText));

    return {
      activeText: normalizeText(activeOption?.innerText),
      bodyText: normalizeText(body?.innerText),
      cardFocused: focused === card,
      pageText,
      selectedTexts,
      visible: Boolean(body && !body.hidden),
    };
  });
}
