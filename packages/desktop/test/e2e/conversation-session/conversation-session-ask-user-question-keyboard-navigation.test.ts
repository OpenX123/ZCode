import { join } from "node:path";
import { Key } from "webdriverio";
import {
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, setCurrentElectronRendererContentSize } from "../helpers/desktop-app.js";
import {
  countUpstreamRequests,
  waitForUpstreamRequest,
} from "../helpers/conversation-session-network.js";
import { waitForToolCallBlockByToolName } from "../helpers/conversation-session-tool.js";
import {
  getV4FocusedPaneId,
  getV4ComposerAttachments,
  getV4ComposerText,
  pasteV4ComposerFileAttachment,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_KEYBOARD_NAV";
const TOOL_MARKER = "E2E_ASK_USER_QUESTION_KEYBOARD_NAV_TOOL";
const CUSTOM_ANSWER_MARKER = "E2E_ASK_USER_QUESTION_KEYBOARD_CUSTOM";
const QUESTION_ONE = "E2E_AQK_Q1_CUSTOM_ENTER";
const QUESTION_TWO = "E2E_AQK_Q2_OPTION_SPACE";
const QUESTION_THREE = "E2E_AQK_Q3_OPTION_ENTER";
const Q2_OPTION_A = "E2E_AQK_Q2_OPTION_A";
const Q2_OPTION_B = "E2E_AQK_Q2_OPTION_B";
const Q3_OPTION_A = "E2E_AQK_Q3_OPTION_A";
const Q3_OPTION_B = "E2E_AQK_Q3_OPTION_B";
const COMPOSER_DRAFT = "E2E_AQK_PRESERVED_COMPOSER_DRAFT";
const COMPOSER_ATTACHMENT = "ux07-preserved-draft.txt";

describe("会话区 AskUserQuestion 键盘导航 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("选择只改草稿，多题可回改，关闭重开后 Tab 到显式发送才响应一次", async function () {
    this.timeout(180000);

    // Bug 根因：已转正用例仍经由 legacy helper 定位消息，
    // 与 formal 目录的 V4 pane 证据合同不一致。
    await setCurrentElectronRendererContentSize(1600, 900);
    await prepareV4ConversationE2E();
    await setPresentation("zh-CN", "zai-light");

    const runId = Date.now();
    const customAnswer = `${CUSTOM_ANSWER_MARKER}_${runId}`;
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${TOOL_MARKER}: ask exactly three questions in one AskUserQuestion call.`,
      `Question 1 text must be ${QUESTION_ONE} and should allow a custom answer.`,
      `Question 2 text must be ${QUESTION_TWO} with options ${Q2_OPTION_A} and ${Q2_OPTION_B}.`,
      `Question 3 text must be ${QUESTION_THREE} with options ${Q3_OPTION_A} and ${Q3_OPTION_B}.`,
      "Do not answer the questions yourself. After the user responds, continue briefly.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);
    await waitForElicitationPage("1 / 3", QUESTION_ONE);
    expect(await readCustomInputSemantics()).toEqual({
      tagName: "TEXTAREA",
      rows: "1",
      autoSizing: true,
    });

    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.activeElement?.getAttribute("data-elicitation-dialog-card") === "true",
        ),
      { timeout: 10000, timeoutMsg: "普通问答初始焦点应在卡片，不能自动进入自定义输入框" },
    );
    await browser.keys("ArrowUp");
    await expectCustomInputFocused();
    const input = await $('[data-elicitation-dialog-body="true"] textarea');
    // 长答案必须真的换行并在五行内滚动；仅断言 CSS class 无法发现布局失效。
    // 满足超过五行的最小长文即可，避免上千逐键更新令 WebDriver 单命令超时。
    await input.setValue("自动换行的自定义回答 wrapped answer ".repeat(40));
    const layout = await browser.execute(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '[data-elicitation-dialog-body="true"] textarea',
      )!;
      const style = getComputedStyle(textarea);
      const markerRect = textarea.previousElementSibling!.getBoundingClientRect();
      return {
        height: textarea.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight),
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
        marker: textarea.previousElementSibling?.textContent,
        markerFirstLineCenterGap: Math.abs(
          markerRect.top +
            markerRect.height / 2 -
            (textarea.getBoundingClientRect().top +
              parseFloat(style.borderTopWidth) +
              parseFloat(style.paddingTop) +
              parseFloat(style.lineHeight) / 2),
        ),
      };
    });
    expect(layout.height).toBeGreaterThan(layout.lineHeight * 4);
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight * 5 + 1);
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    expect(layout.marker).toBe("3.");
    expect(layout.markerFirstLineCenterGap).toBeLessThanOrEqual(0.5);

    await focusCustomInputAndSetValue(customAnswer);
    // composition 事件模拟应用输入法事件链，Enter 由真实 WebDriver 键盘发送。
    await browser.execute(() =>
      document
        .querySelector("textarea")
        ?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
    await browser.keys(Key.Enter);
    await waitForElicitationPage("1 / 3", QUESTION_ONE);
    await browser.execute(() =>
      document
        .querySelector('[data-elicitation-dialog-body="true"] textarea')
        ?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await browser.keys(Key.Enter);
    await waitForElicitationPage("1 / 3", QUESTION_ONE);
    expect(await countUpstreamRequests({ includes: [customAnswer] })).toBe(0);
    await focusCustomInputAndSetValue(customAnswer);
    await activatePrimaryByKeyboard();
    await waitForElicitationPage("2 / 3", QUESTION_TWO);

    await browser.keys("2");
    await expectActiveOption(Q2_OPTION_B);
    expect(
      (await getElicitationKeyboardSnapshot()).selectedTexts.some((text) =>
        text.includes(Q2_OPTION_B),
      ),
    ).toBe(true);
    await waitForElicitationPage("2 / 3", QUESTION_TWO);
    expect(await countUpstreamRequests({ includes: [customAnswer] })).toBe(0);
    await $('[aria-label="上一题"]').click();
    await waitForElicitationPage("1 / 3", QUESTION_ONE);
    await expectCustomInputValue(customAnswer);
    await focusCustomInputAndSetValue(`${customAnswer}_revised`);
    await activatePrimaryByKeyboard();
    await waitForElicitationPage("2 / 3", QUESTION_TWO);

    await $('[aria-label="折叠问题弹窗"]').click();
    await $('[data-elicitation-waiting="true"]').waitForDisplayed();
    expect(await $('[data-elicitation-dialog-body="true"]').isDisplayed()).toBe(false);
    await $('[data-elicitation-waiting="true"] [aria-label="展开问题弹窗"]').click();
    await waitForElicitationPage("2 / 3", QUESTION_TWO);
    expect(
      (await getElicitationKeyboardSnapshot()).selectedTexts.some((text) =>
        text.includes(Q2_OPTION_B),
      ),
    ).toBe(true);
    await verifyOtherPaneKeepsFocus();
    await seedBlockedComposerDraft();
    await $('[aria-label="折叠问题弹窗"]').click();
    await $('[data-elicitation-waiting="true"]').waitForDisplayed();
    await expectComposerDraftPreserved(true);
    await $('[data-elicitation-waiting="true"] [aria-label="展开问题弹窗"]').click();
    await waitForElicitationPage("2 / 3", QUESTION_TWO);
    await expectComposerDraftPreserved(true);
    await capturePresentations();
    await $('[data-elicitation-dialog-body="true"] textarea').click();
    await activatePrimaryByKeyboard();
    await waitForElicitationPage("3 / 3", QUESTION_THREE);
    await browser.keys(Key.ArrowDown);
    await expectActiveOption(Q3_OPTION_A);
    await browser.keys(Key.Enter);
    await waitForElicitationPage("3 / 3", QUESTION_THREE);
    expect(await countUpstreamRequests({ includes: [customAnswer] })).toBe(0);
    await preserveLateResponse();
    await activatePrimaryByKeyboard();

    await waitForUpstreamRequest(
      {
        includes: [`${customAnswer}_revised`, Q2_OPTION_B, Q3_OPTION_A, TOOL_MARKER],
      },
      "AskUserQuestion 键盘选择结果没有进入下一次模型请求",
      60000,
    );
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => document.querySelectorAll('[data-elicitation-dialog-card="true"]').length === 0,
        ),
      { timeout: 15000, timeoutMsg: "真实 Host 响应后 pending 问题卡未撤销" },
    );
    await expectComposerDraftPreserved(false);
    expect(await countUpstreamRequests({ includes: [COMPOSER_DRAFT] })).toBe(0);
    const late = await browser.execute(async () => {
      const state = (
        window as typeof window & {
          __ux07Late?: { respond(): void; count(): number; restore(): void };
        }
      ).__ux07Late!;
      const before = state.count();
      state.respond();
      await Promise.resolve();
      await Promise.resolve();
      const after = state.count();
      state.restore();
      return { before, after };
    });
    expect(late.before).toBe(1);
    expect(late.after).toBe(1);
    expect(
      await countUpstreamRequests({
        includes: [`${customAnswer}_revised`, Q2_OPTION_B, Q3_OPTION_A],
      }),
    ).toBe(1);
  });
});

interface ElicitationKeyboardSnapshot {
  activeText: string;
  bodyText: string;
  customInputValue: string;
  focusedTag: string;
  pageText: string | null;
  selectedTexts: string[];
  visible: boolean;
}

async function waitForElicitationPage(pageText: string, questionText: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return (
          latest.visible && latest.pageText === pageText && latest.bodyText.includes(questionText)
        );
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 没有进入目标题目 ${pageText} ${questionText}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 没有进入目标题目; expected=${pageText}/${questionText}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function focusCustomInputAndSetValue(value: string) {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  await input.click();
  await input.setValue(value);
  await expectCustomInputValue(value);
}

async function expectCustomInputValue(value: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.customInputValue === value;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 自定义回答输入框内容不符合预期",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 自定义回答输入框内容不符合预期; expected=${value}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectCustomInputFocused() {
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.activeElement ===
          document.querySelector('[data-elicitation-dialog-body="true"] textarea'),
      ),
    { timeout: 10000, timeoutMsg: "上下键没有把真实焦点移到自定义输入框" },
  );
}

function readCustomInputSemantics() {
  return browser.execute(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-elicitation-dialog-body="true"] textarea',
    );
    return {
      tagName: textarea?.tagName ?? null,
      rows: textarea?.getAttribute("rows") ?? null,
      autoSizing: textarea?.classList.contains("field-sizing-content") ?? false,
    };
  });
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
        timeoutMsg: `AskUserQuestion 当前预选项不是 ${optionText}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 当前预选项不是 ${optionText}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

function getElicitationKeyboardSnapshot(): Promise<ElicitationKeyboardSnapshot> {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
    const focused = document.activeElement as HTMLElement | null;
    // 修复原因：普通问答切题后卡片本身获得焦点，第一项仅作为 roving
    // tabindex 入口保留 tabindex=0，不能把它误判为真实焦点。
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
    const input = body?.querySelector<HTMLTextAreaElement>("textarea") ?? null;

    return {
      activeText: normalizeText(activeOption?.innerText),
      bodyText: normalizeText(body?.innerText),
      customInputValue: input?.value ?? "",
      focusedTag: focused?.tagName ?? "",
      pageText,
      selectedTexts,
      visible: Boolean(body && !body.hidden),
    };
  });
}

async function activatePrimaryByKeyboard() {
  for (let index = 0; index < 8; index += 1) {
    await browser.keys(Key.Tab);
    const focused = await browser.execute(
      () =>
        document.activeElement ===
        document.querySelector('[data-elicitation-dialog-footer="true"] button:last-child'),
    );
    if (focused) {
      await browser.keys(Key.Enter);
      return;
    }
  }
  throw new Error("真实 Tab 未到达问题卡主确认按钮");
}

async function setPresentation(locale: "zh-CN" | "en-US", theme: "zai-light" | "zai-dark") {
  await browser.execute(
    (value) => {
      const actions = (
        window as typeof window & {
          __testActions: { setLocale(locale: string): void; setTheme(theme: string): void };
        }
      ).__testActions;
      actions.setLocale(value.locale);
      actions.setTheme(value.theme);
    },
    { locale, theme },
  );
}

async function verifyOtherPaneKeepsFocus() {
  const leftId = await getV4FocusedPaneId();
  await $('[data-testid="workbench-layout-menu"]').click();
  await $('[data-testid="workbench-split-right"]').click();
  await browser.waitUntil(
    async () =>
      await browser.execute(
        () => document.querySelectorAll('[data-pane-id][data-group-active="true"]').length === 2,
      ),
    { timeout: 15000 },
  );
  const rightId = await getV4FocusedPaneId();
  expect(rightId).not.toBe(leftId);
  const composer = await $(`[data-pane-id="${rightId}"] [contenteditable="true"]`);
  await composer.click();
  await browser.keys("E2E_OTHER_PANE_DRAFT");
  await setPresentation("en-US", "zai-dark");
  expect(await composer.isFocused()).toBe(true);
  await setCurrentElectronRendererContentSize(700, 900);
  await browser.keys("_HIDDEN_CARD");
  expect(await composer.isFocused()).toBe(true);
  expect(await composer.getText()).toContain("E2E_OTHER_PANE_DRAFT_HIDDEN_CARD");
  expect(await getV4FocusedPaneId()).toBe(rightId);
  await setCurrentElectronRendererContentSize(1600, 900);
  await $(`[data-testid="workbench-close-pane-${rightId}"]`).click();
  await setPresentation("zh-CN", "zai-light");
}

async function seedBlockedComposerDraft() {
  // 仅用既有 Lexical bridge / paste helper 布置非空底层草稿，不把隐藏输入框冒充可操作入口。
  await setV4ComposerText(COMPOSER_DRAFT);
  await pasteV4ComposerFileAttachment(COMPOSER_ATTACHMENT, {
    base64: Buffer.from("UX07 draft attachment").toString("base64"),
    mimeType: "text/plain",
  });
  await browser.waitUntil(
    async () =>
      (await getV4ComposerAttachments()).some(
        (item) => item.text.includes(COMPOSER_ATTACHMENT) && item.uploadStatus === "ready",
      ),
    { timeout: 15000, timeoutMsg: "普通 composer 的真实附件管线没有进入 ready" },
  );
  const paneId = await getV4FocusedPaneId();
  if (!paneId) throw new Error("布置草稿时没有当前焦点 pane");
  const installed = await browser.execute(
    (paneTestId, composerTestId, inputTestId) => {
      const pane = document.querySelector(`[data-testid="${paneTestId}"]`);
      const composer = pane?.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const editor = composer?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      if (!pane || !composer || !editor) return false;
      (
        window as typeof window & {
          __ux07ComposerProbe?: () => {
            sameComposer: boolean;
            sameEditor: boolean;
            hidden: boolean;
            ariaHidden: string | null;
            inDock: boolean;
            interactionBeforeComposer: boolean;
          };
        }
      ).__ux07ComposerProbe = () => {
        const card = pane.querySelector('[data-elicitation-dialog-card="true"]');
        const dock = composer.closest('[data-v4-composer-dock="true"]');
        return {
          sameComposer:
            composer.isConnected &&
            pane.querySelector(`[data-testid="${composerTestId}"]`) === composer,
          sameEditor:
            editor.isConnected &&
            composer.querySelector(`[data-testid="${inputTestId}"]`) === editor,
          hidden: getComputedStyle(composer).display === "none",
          ariaHidden: composer.getAttribute("aria-hidden"),
          inDock: Boolean(dock),
          interactionBeforeComposer: Boolean(
            card &&
            card.closest('[data-v4-composer-dock="true"]') === dock &&
            card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        };
      };
      return true;
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_COMPOSER,
    TID_V4_COMPOSER_INPUT,
  );
  expect(installed).toBe(true);
  await expectComposerDraftPreserved(true);
}

async function expectComposerDraftPreserved(blocked: boolean) {
  const state = await browser.execute(() =>
    (
      window as typeof window & {
        __ux07ComposerProbe?: () => {
          sameComposer: boolean;
          sameEditor: boolean;
          hidden: boolean;
          ariaHidden: string | null;
          inDock: boolean;
          interactionBeforeComposer: boolean;
        };
      }
    ).__ux07ComposerProbe?.(),
  );
  expect(state).toMatchObject({
    sameComposer: true,
    sameEditor: true,
    hidden: blocked,
    ariaHidden: blocked ? "true" : null,
    inDock: true,
    ...(blocked ? { interactionBeforeComposer: true } : {}),
  });
  expect(await getV4ComposerText()).toBe(COMPOSER_DRAFT);
  expect(await getV4ComposerAttachments()).toEqual([
    { text: expect.stringContaining(COMPOSER_ATTACHMENT), uploadStatus: "ready" },
  ]);
}

async function capturePresentations() {
  const screenshotDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
  if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "ux07-light-zh.png"));
  const size = await setCurrentElectronRendererContentSize(1600, 900);
  const minimum = await browser.electron.execute((electron, id) => {
    const window = electron.BrowserWindow.fromId(id)!;
    const previous = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return previous;
  }, size.windowId);
  try {
    await setCurrentElectronRendererContentSize(430, 900);
    await setPresentation("en-US", "zai-dark");
    const drawer = await $('[data-testid="workspace-sidebar-drawer-backdrop"]');
    if (await drawer.isDisplayed()) {
      await browser.action("pointer").move({ x: 420, y: 450 }).down().up().perform();
      await drawer.waitForDisplayed({ reverse: true });
    }
    // backdrop 先卸载，侧栏仍有退出动画；按实际几何等待完全移出，避免截图被残影遮挡。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const sidebar = document.querySelector<HTMLElement>(
            '[data-workspace-sidebar-panel="true"]',
          );
          return !sidebar || sidebar.getBoundingClientRect().right <= 0.5;
        }),
      { timeout: 10000, timeoutMsg: "窄屏 sidebar drawer 尚未完全移出视口" },
    );
    const layout = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('[data-elicitation-dialog-card="true"]')!;
      const footer = card.querySelector<HTMLElement>('[data-elicitation-dialog-footer="true"]')!;
      const dock = card.closest('[data-v4-composer-dock="true"]');
      const rect = card.getBoundingClientRect();
      const actionRect = footer.getBoundingClientRect();
      return {
        width: innerWidth,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        height: innerHeight,
        footerVisible: actionRect.bottom <= innerHeight && actionRect.height > 0,
        inComposerDock: Boolean(dock),
      };
    });
    expect(Math.abs(layout.width - 430)).toBeLessThanOrEqual(1);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.footerVisible).toBe(true);
    expect(layout.inComposerDock).toBe(true);
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "ux07-narrow-dark-en.png"));
  } finally {
    await setCurrentElectronRendererContentSize(1600, 900);
    await browser.electron.execute(
      (electron, id, min) => electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
      size.windowId,
      minimum,
    );
    await setPresentation("zh-CN", "zai-light");
  }
}

async function preserveLateResponse() {
  const captured = await browser.execute(() => {
    type Props = {
      request?: { type: string; requestId: string };
      onRespond?: (id: string, action: string, content: Record<string, unknown>) => void;
    };
    type Fiber = { return?: Fiber; memoizedProps?: Props };
    const card = document.querySelector(
      '[data-elicitation-dialog-card="true"]',
    ) as unknown as Record<string, unknown>;
    const fiberKey = Object.keys(card).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? (card[fiberKey] as Fiber) : undefined;
    while (
      fiber &&
      !(
        fiber.memoizedProps?.request?.type === "elicitation_request" &&
        fiber.memoizedProps.onRespond
      )
    )
      fiber = fiber.return;
    const props = fiber?.memoizedProps;
    if (!props?.onRespond || !props.request) return false;
    const respond = props.onRespond;
    const requestId = props.request.requestId;
    const original = MessagePort.prototype.postMessage;
    let count = 0;
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (
        message instanceof Uint8Array &&
        new TextDecoder().decode(message).includes('"type":"resolveInteraction"')
      )
        count += 1;
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    (
      window as typeof window & {
        __ux07Late?: { respond(): void; count(): number; restore(): void };
      }
    ).__ux07Late = {
      respond: () => respond(requestId, "accept", { answers: { late: "E2E_LATE_MUST_NOT_SEND" } }),
      count: () => count,
      restore: () => {
        MessagePort.prototype.postMessage = original;
      },
    };
    return true;
  });
  expect(captured).toBe(true);
}
