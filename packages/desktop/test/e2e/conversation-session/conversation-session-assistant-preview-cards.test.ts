/* eslint-disable max-lines -- APC01-APC12 共用真实 Host stat、Browser/Preview Pane 与 cold-resume fixture。 */
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared/external-engine";
import { resolveE2EStorageRoot } from "../helpers/e2e-runtime-paths.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_WEBVIEW,
  TID_PREVIEW_PANE,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import { restartIntoWorkspacePreservingProfile as restartCurrentWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import {
  clickV4Stop,
  clickV4TimelineBackToBottom,
  getV4FocusedPaneId,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  selectV4TaskById,
  sendV4Prompt,
  sendV4PromptInPane,
  startNewV4Draft,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_ASSISTANT_PREVIEW_CARDS";
const CASE_RELATIVE_ROOT = "assistant-preview-e2e";
const CASE_ROOT = join(DEFAULT_WORKSPACE, CASE_RELATIVE_ROOT);
const OFFICE_FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const STREAM_URL = "http://localhost:41789/assistant-preview-stream";

const SOURCE_HTML_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/本轮 输出/index 页面.html`;
const SOURCE_MARKDOWN_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/本轮 输出/说明 文档.md`;
const SOURCE_HTML_PATH = join(DEFAULT_WORKSPACE, SOURCE_HTML_RELATIVE_PATH);

const OFFICE_FILES = [
  { fixture: "sample.docx", name: "项目 简介.docx" },
  { fixture: "sample.xlsx", name: "年度 总结.xlsx" },
  { fixture: "sample.pptx", name: "产品 路线.pptx" },
  { fixture: "sample.pdf", name: "审计 报告.pdf" },
] as const;
const MEDIA_FILES = ["生成 视频.mp4", "生成 音频.wav"] as const;

interface PreviewCardSnapshot {
  text: string;
  title: string;
}

type NativeMediaProbeWindow = Window & {
  __ux05VirtualizationProbe?: {
    turn: HTMLElement;
    image: HTMLImageElement;
    media: HTMLMediaElement[];
    imageSource: string;
    sources: string[];
  };
};

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";
let retryMediaAvailable = false;
let fixtureVideo: Buffer;
let fixtureImage: Buffer;

async function setExcerptPresentation(locale: "zh-CN" | "en-US", theme: "zai-light" | "zai-dark") {
  const result = await browser.executeAsync(
    (next, done: (result: string) => void) => {
      const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
        .__testActions;
      if (typeof actions?.setLocale !== "function" || typeof actions?.setTheme !== "function") {
        done("缺少locale/theme测试入口");
        return;
      }
      (actions.setLocale as (value: string) => void)(next.locale);
      (actions.setTheme as (value: string) => void)(next.theme);
      requestAnimationFrame(() => done("ok"));
    },
    { locale, theme },
  );
  expect(result).toBe("ok");
}

describe("Assistant Preview Cards E2E", () => {
  before(async () => {
    [fixtureVideo, fixtureImage] = await Promise.all([
      readFile(new URL("../fixtures/media/sample-video.mp4", import.meta.url)),
      readFile(
        new URL(
          "../fixtures/fs/conversation-session/conversation-session-stop-tool-results/first.png",
          import.meta.url,
        ),
      ),
    ]);
    fixtureServer = createFixtureServer();
    fixtureRootUrl = await listen(fixtureServer);
  });

  afterEach(async () => {
    await closeSidePanes();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("UX05 展示：网页卡、直接及本地媒体、失效重试、最终正文入口", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    retryMediaAvailable = false;
    await setExcerptPresentation("zh-CN", "zai-light");
    const marker = `${CASE_MARKER}_UX05_DISPLAY`;
    await sendV4Prompt(`${marker} E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`);
    await waitForCompleted(`${marker}_DONE`);
    await assertLoadedAssistantMedia(3);
    await browser.waitUntil(
      async () =>
        (await readPreviewCards(["UX05 公共网站"])).some((card) => card.title === "UX05 公共网站"),
      { timeout: 30_000 },
    );
    await clickPreviewCard("UX05 公共网站");
    await browser.waitUntil(
      async () =>
        (await browser.$(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`).getValue()) ===
        "https://example.com/ux05",
      { timeout: 10_000 },
    );
    await closeSidePanes();
    const failed = await browser.$(
      `[data-assistant-media]:has(button[title="${fixtureRootUrl}-retry.wav"])`,
    );
    await failed.$('[role="alert"]').waitForDisplayed();
    expect(await failed.getText()).toContain(`${fixtureRootUrl}-retry.wav`);
    retryMediaAvailable = true;
    await failed.$("button=重试").click();
    await browser.waitUntil(async () => failed.$("audio").isExisting(), { timeout: 10_000 });
    await assertLoadedAssistantMedia(4);
    const image = await browser.$('img[alt="UX05 图片"]');
    await image.scrollIntoView();
    await browser.waitUntil(
      async () => browser.execute((el) => (el as HTMLImageElement).naturalWidth > 0, image),
      { timeout: 10_000 },
    );
    const fence = await browser.$("[data-assistant-text-fence-link]");
    await fence.scrollIntoView();
    await fence.click();
    await waitForBrowserSurface(`${fixtureRootUrl}-final?next=(step)&x=1`, "APC01_LOCAL_URL_PAGE");
    await closeSidePanes();
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots) await browser.saveScreenshot(join(screenshots, "ux05-display-light-zh.png"));
    await assertNarrowMediaLayout();
  }).timeout(240_000);

  it("UX05 原生：ACP 媒体经真实 artifact/Host 读取并在虚拟滚动重挂、刷新、冷恢复后可用", async () => {
    await skipOccupationOnboardingIfPresent();
    await startNewV4Draft();
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    const marker = `${CASE_MARKER}_UX05_NATIVE_DONE`;
    await installNativeMediaAdapter([
      { type: "image", mimeType: "image/png", data: fixtureImage.toString("base64") },
      { type: "audio", mimeType: "audio/wav", data: createFixtureWav().toString("base64") },
      {
        type: "resource",
        resource: {
          uri: "file:///fixture/video.mp4",
          mimeType: "video/mp4",
          blob: fixtureVideo.toString("base64"),
        },
      },
      {
        type: "resource_link",
        uri: `${fixtureRootUrl}-download`,
        mimeType: "audio/wav",
        name: "无扩展名音频",
      },
      {
        type: "resource",
        resource: {
          uri: "https://example.com/unknown",
          mimeType: "application/x-unknown",
          text: "UX05 未知资源说明",
        },
      },
      { type: "text", text: marker },
    ]);
    const paneId = await getV4FocusedPaneId();
    if (!paneId) throw new Error("缺少当前 pane");
    const trigger = await browser.$(
      `[data-testid="v4-session-pane-${paneId}"] [data-testid="chat-model-select-trigger"], [data-testid="v4-session-pane-${paneId}"] [data-testid="engine-config-model-effort"]`,
    );
    await trigger.click();
    await browser.$('[data-testid="engine-switch-option-claude-code"]').click();
    if (await browser.$('[data-testid="engine-switch-row"]').isDisplayed())
      await browser.keys("Escape");
    await sendV4PromptInPane(paneId, "UX05 验证原生输出媒体");
    await waitForCompleted(marker);
    const sessionId = await waitForBoundSession(marker);
    await assertNativeMediaOutsideHistory();
    await assertLoadedAssistantMedia(3);
    const sourceButton = await browser.$(
      "[data-conversation-deliverable] [data-deliverable-show-source]",
    );
    await sourceButton.click();
    expect(
      await browser
        .$('[data-testid^="chat-assistant-history-trigger-"]')
        .getAttribute("data-history-open"),
    ).toBe("true");
    expect(await browser.$("body").getText()).toContain("UX05 未知资源说明");
    await browser.$('[data-testid^="chat-assistant-history-trigger-"]').click();
    await startNewV4Draft();
    await selectV4TaskById(sessionId);
    await waitForCompleted(marker);
    await assertNativeMediaOutsideHistory();
    await assertLoadedAssistantMedia(3);
    await browser.refresh();
    await selectV4TaskById(sessionId, 60_000);
    await waitForCompleted(marker);
    await assertNativeMediaOutsideHistory();
    await assertLoadedAssistantMedia(3);
    const nativeWorkspace = await browser.execute(
      () =>
        (
          window as Window & {
            __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
          }
        ).__zcodeTabStoreE2E?.getState().activeWorkspacePath,
    );
    if (!nativeWorkspace) throw new Error("缺少原生任务实际工作区");
    // 无项目任务使用自己的 draft workspace；不能等待无关的固定 ZCodeProject。
    await restartCurrentWorkspacePreservingProfile(nativeWorkspace);
    await selectV4TaskById(sessionId, 60_000);
    await waitForCompleted(marker);
    await assertNativeMediaOutsideHistory();
    await assertLoadedAssistantMedia(3);
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots) await browser.saveScreenshot(join(screenshots, "ux05-native-cold.png"));
    await assertNativeMediaVirtualized(marker);
  }).timeout(360_000);

  it("UX04: 非最终正文关键入口在已工作折叠外可见，并保留原始上下文", async () => {
    await browser.waitUntil(
      async () =>
        (await browser.$('[data-testid="onboarding-page"]').isExisting()) ||
        (await browser.$('[data-testid="task-settings-button"]').isExisting()),
      { timeout: 30_000 },
    );
    await browser.keys("Escape");
    await prepareCase({ yolo: true });
    await setExcerptPresentation("zh-CN", "zai-light");
    const marker = `${CASE_MARKER}_WORK_EXCERPT`;
    await sendV4Prompt(
      `${marker}: publish the entry before working. E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
    );
    await waitForCompleted(`${marker}_DONE`);
    const sessionId = await waitForBoundSession(marker);
    const excerpt = await browser.$(
      `[data-conversation-deliverable]:has(button[title="${fixtureRootUrl}"])`,
    );
    await excerpt.waitForDisplayed();
    expect(await excerpt.getText()).toContain("请打开此入口继续操作");
    expect(await excerpt.$(`button[title="${fixtureRootUrl}"]`).isDisplayed()).toBe(true);
    expect(await excerpt.$$('[data-testid^="v4-fork"], [data-testid^="v4-retry"]').length).toBe(0);
    const sourceKey = await excerpt.getAttribute("data-conversation-deliverable");
    const history = await browser.$('[data-testid^="chat-assistant-history-content"]');
    expect(await history.isDisplayed()).toBe(false);
    const screenshotDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "ux04-collapsed.png"));
    await excerpt.$("[data-deliverable-show-source]").click();
    await history.waitForDisplayed();
    expect(await history.getText()).toContain("请打开此入口继续操作");
    expect(await excerpt.getAttribute("data-conversation-deliverable")).toBe(sourceKey);
    const trigger = await browser.$('[data-testid^="chat-assistant-history-trigger"]');
    await trigger.click();
    await history.waitForDisplayed({ reverse: true });
    await excerpt.$(`button[title="${fixtureRootUrl}"]`).click();
    await waitForBrowserSurface(fixtureRootUrl, "APC01_LOCAL_URL_PAGE");
    await closeSidePanes();
    const textEntryUrl = `${fixtureRootUrl}-text-entry?next=(step)&label=%E4%B8%AD%E6%96%87%20path&angle=%3Cdone%3E`;
    const textEntry = await browser.$("button[data-deliverable-open-link]");
    expect(await textEntry.getAttribute("title")).toBe(textEntryUrl);
    await textEntry.scrollIntoView();
    // 真实 Tab 聚焦与 Enter 激活，验证原生按钮可用且完整 URL 没有经过 Markdown 重建。
    await excerpt.$("[data-deliverable-show-source]").click();
    await trigger.click();
    for (let step = 0; step < 16 && !(await textEntry.isFocused()); step += 1) {
      await browser.keys("Tab");
    }
    expect(await textEntry.isFocused()).toBe(true);
    await browser.keys("Enter");
    await waitForBrowserSurface(textEntryUrl, "APC01_LOCAL_URL_PAGE");
    await closeSidePanes();
    await startNewV4Draft();
    expect(await browser.$("[data-conversation-deliverable]").isExisting()).toBe(false);
    await selectV4TaskById(sessionId);
    const restored = await browser.$(
      `[data-conversation-deliverable]:has(button[title="${fixtureRootUrl}"])`,
    );
    await restored.waitForDisplayed();
    expect(await restored.getAttribute("data-conversation-deliverable")).toBe(sourceKey);
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "ux04-restored.png"));
    const originalWindow = await setCurrentElectronRendererContentSize(1280, 900);
    const minimum = await browser.electron.execute((electron, id) => {
      const window = electron.BrowserWindow.fromId(id)!;
      const previous = window.getMinimumSize();
      // 仅测试窄屏：Windows 原生最小宽为 481px，暂时下调后验证真实 430px viewport。
      window.setMinimumSize(320, 400);
      return previous;
    }, originalWindow.windowId);
    try {
      await setCurrentElectronRendererContentSize(430, 900);
      await setExcerptPresentation("en-US", "zai-dark");
      const drawer = await browser.$('[data-testid="workspace-sidebar-drawer-backdrop"]');
      if (await drawer.isDisplayed()) {
        // 窄屏标题栏被 drawer 自身拖拽区覆盖，真实点击右侧露出的 backdrop 收起。
        await browser.action("pointer").move({ x: 420, y: 450 }).down().up().perform();
        await drawer.waitForDisplayed({ reverse: true });
      }
      await restored.scrollIntoView();
      expect(await restored.$("[data-deliverable-show-source]").getText()).toBe(
        "View original context",
      );
      const layout = await browser.execute(() => ({
        width: window.innerWidth,
        excerpts: Array.from(document.querySelectorAll("[data-conversation-deliverable]")).map(
          (node) => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          },
        ),
      }));
      if (screenshotDir) {
        await browser.saveScreenshot(join(screenshotDir, "ux04-narrow-dark-en.png"));
        await writeFile(join(screenshotDir, "ux04-layout.json"), JSON.stringify(layout, null, 2));
      }
      // 与精确窗口 helper 相同：Windows 物理像素换算允许 1px 原生舍入，布局仍用实际宽度校验。
      expect(Math.abs(layout.width - 430)).toBeLessThanOrEqual(1);
      expect(layout.excerpts).toHaveLength(1);
      for (const rect of layout.excerpts) {
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(layout.width + 1);
      }
    } finally {
      await browser.electron.execute(
        (electron, id, min) => electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
        originalWindow.windowId,
        minimum,
      );
      await restoreElectronRendererContentSize(originalWindow);
      await setExcerptPresentation("zh-CN", "zai-light");
    }
  }).timeout(240_000);

  it("APC01/APC04: completed localhost URL 去重并打开真实 Browser 页面", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_LOCAL_URL`;
    await sendV4Prompt(
      `${marker}: reply with the same local preview URL more than once. E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
    );
    await waitForCompleted(`${marker}_DONE`);

    await waitForPreviewCards(["APC Local Preview"]);
    await clickPreviewCard("APC Local Preview");
    await waitForBrowserSurface(fixtureRootUrl, "APC01_LOCAL_URL_PAGE");
  }).timeout(180_000);

  it("APC02: interrupted turn 在 URL 已到达后 Stop，卡片只在终态出现", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_INTERRUPTED`;
    await sendV4Prompt(`${marker}: keep streaming after publishing ${STREAM_URL}.`);
    await waitForV4AssistantMessageContaining(`${marker}_EARLY`, 60_000);
    expect(await readPreviewCards()).toEqual([]);

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${marker}_EARLY`),
      "APC02 Stop 后 turn 没有进入 interrupted 终态",
      60_000,
    );
    await waitForPreviewCards(["assistant-preview-stream"]);
  }).timeout(180_000);

  it("APC03: streaming 期间不显示卡片，complete 后显示", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_STREAMING`;
    await sendV4Prompt(`${marker}: stream ${STREAM_URL} before the final marker.`);
    await waitForV4AssistantMessageContaining(`${marker}_EARLY`, 60_000);
    expect(await readPreviewCards()).toEqual([]);

    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["assistant-preview-stream"]);
  }).timeout(180_000);

  it("APC04: localhost 与本轮 HTML 同时出现时按现有业务规则抑制 HTML", async () => {
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_LOCAL_SUPPRESSES_HTML`;
    await sendV4Prompt(
      `${marker}: create ${SOURCE_HTML_RELATIVE_PATH}, then mention it with E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}.`,
    );
    await waitForCompleted(`${marker}_DONE`);

    await waitForPreviewCards(["APC Local Only"]);
    await expectPreviewCardMissing(basename(SOURCE_HTML_RELATIVE_PATH));
  }).timeout(180_000);

  it("APC06/APC07: source gate、Office 自动打开 PPTX", async () => {
    await prepareCase();
    await materializeOfficeFixtures();
    await materializeStaleSourceFiles();
    const marker = `${CASE_MARKER}_OFFICE`;
    await sendV4Prompt(`${marker}_PPTX: report the prepared Office files and one missing PDF.`);
    await waitForCompleted(`${marker}_PPTX_DONE`);

    const officeTitles = [...OFFICE_FILES].reverse().map((item) => item.name);
    await waitForPreviewCards(officeTitles);
    await expectPreviewCardMissing("旧 页面.html");
    await expectPreviewCardMissing("旧 说明.md");
    await expectPreviewCardMissing("不存在.pdf");
    await waitForPreviewRenderer("产品 路线.pptx", "pptx");
    for (const file of OFFICE_FILES) {
      await assertFileOpenApps(file.name);
    }
  }).timeout(240_000);

  it("APC14: card context actions preserve the original Open dropdown", async () => {
    // 隔离 profile 的首次引导可能尚在异步加载；通过已有 Escape 退出路径准备场景。
    await browser.waitUntil(
      async () =>
        (await browser.$('[data-testid="onboarding-page"]').isExisting()) ||
        (await browser.$('[data-testid="task-settings-button"]').isExisting()),
      { timeout: 30_000 },
    );
    await browser.keys("Escape");
    await prepareCase();
    await materializeOfficeFixtures();
    const marker = `${CASE_MARKER}_OFFICE`;
    await sendV4Prompt(`${marker}_PPTX: report the prepared Office files and one missing PDF.`);
    await waitForCompleted(`${marker}_PPTX_DONE`);
    await waitForPreviewCards([...OFFICE_FILES].reverse().map((item) => item.name));
    await closeSidePanes();
    const row = await browser.$('[data-preview-card-title="产品 路线.pptx"]');
    await row.click({ button: "right" });
    await browser.$('[data-slot="context-menu-content"][data-state="open"]').waitForDisplayed();
    const screenshotDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "preview-card-menu.png"));
    // 关闭动画中的旧菜单仍在 DOM，断言只读取当前打开的菜单。
    const labels = await browser
      .$$('[role="menu"][data-state="open"] [role="menuitem"]')
      .map((item) => item.getText());
    expect(labels.slice(0, 2)).toEqual(
      [/^(Preview|预览)$/, /^(Open|打开)$/].map((label) => expect.stringMatching(label)),
    );
    expect(labels.some((label) => /Open containing folder|打开所在目录/.test(label))).toBe(false);
    await browser.keys("Escape");
    await row.$('button[aria-label="Choose app"], button[aria-label="选择打开方式"]').click();
    const dropdown = await browser.$('[data-slot="dropdown-menu-content"][data-state="open"]');
    await dropdown.waitForDisplayed();
    const dropdownText = await dropdown.getText();
    expect(dropdownText).toMatch(/Copy absolute path|复制绝对路径/);
    expect(dropdownText).not.toMatch(
      /Preview in side pane|在侧边栏预览|Open containing folder|打开所在目录/,
    );
    expect(await dropdown.$('[data-slot="dropdown-menu-sub-trigger"]').isExisting()).toBe(false);
    await browser.keys("Escape");
    const openPath = await browser.electron.mock("shell", "openPath");
    await openPath.mockResolvedValue("");
    try {
      await row.click({ button: "right" });
      await browser.$('[role="menu"][data-state="open"] [role="menuitem"]').click();
      await waitForPreviewRenderer("产品 路线.pptx", "pptx");
      await row.click({ button: "right" });
      const items = await browser.$$('[role="menu"][data-state="open"] [role="menuitem"]');
      const expectedPath = join(CASE_ROOT, "office", "产品 路线.pptx");
      for (const item of items) {
        if (/^(Open|打开)$/.test(await item.getText())) {
          await item.click();
          break;
        }
      }
      await browser.waitUntil(
        async () => {
          try {
            await expect(openPath).toHaveBeenCalledWith(await realpath(expectedPath));
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000, timeoutMsg: `Menu action did not open ${expectedPath}` },
      );
    } finally {
      await browser.electron.restoreAllMocks();
    }
  }).timeout(240_000);

  it("APC12: 独立音频消息打开原生 audio 播放器", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    const marker = `${CASE_MARKER}_OFFICE_AUDIO`;
    await sendV4Prompt(`${marker}: report the prepared audio file only.`);
    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["生成 音频.wav"]);
    const logSnapshot = await snapshotDesktopRuntimeLogs();
    await clickPreviewCard("生成 音频.wav");
    await waitForPreviewRenderer("生成 音频.wav", "audio");
    await assertLocalMediaPreviewLogs(logSnapshot);
  }).timeout(180_000);

  it("APC12: 独立视频消息打开并保持 media 节点", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    const marker = `${CASE_MARKER}_OFFICE_VIDEO`;
    await sendV4Prompt(`${marker}: report the prepared video file only.`);
    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["生成 视频.mp4"]);
    await assertFileOpenApps("生成 视频.mp4");
    const logSnapshot = await snapshotDesktopRuntimeLogs();
    await clickPreviewCard("生成 视频.mp4");
    await waitForPreviewRenderer("生成 视频.mp4", "video");
    const mediaUrl = await browser.execute(
      () => document.querySelector<HTMLVideoElement>("video[controls]")?.currentSrc ?? "",
    );
    expect(mediaUrl).not.toBe("");
    expect(new URL(mediaUrl).protocol).toBe("zcode-media:");
    await assertPreviewVideoSurvivesResizeAndFullscreen();
    await assertLocalMediaPreviewLogs(logSnapshot);
  }).timeout(180_000);

  it("APC08: 最多显示 10 张，并且前 15 个不足时不从第 16 个以后回填", async () => {
    await prepareCase();
    await materializeBoundFiles();

    const maxMarker = `${CASE_MARKER}_MAX_TEN`;
    await sendV4Prompt(`${maxMarker}: list the twelve prepared max-bound PDF paths in order.`);
    await waitForCompleted(`${maxMarker}_DONE`);
    await waitForPreviewCards(
      Array.from({ length: 10 }, (_, index) => `max-${String(12 - index).padStart(2, "0")}.pdf`),
    );
    await expectPreviewCardMissing("max-02.pdf");
    await expectPreviewCardMissing("max-01.pdf");

    await prepareCase();
    await materializeBoundFiles();
    const noFillMarker = `${CASE_MARKER}_NO_BACKFILL`;
    await sendV4Prompt(
      `${noFillMarker}: list all sixteen no-backfill PDF paths in ascending order.`,
    );
    await waitForCompleted(`${noFillMarker}_DONE`);
    await waitForPreviewCards(
      Array.from({ length: 9 }, (_, index) => `nofill-${String(16 - index).padStart(2, "0")}.pdf`),
    );
    await expectPreviewCardMissing("nofill-01.pdf");
  }).timeout(240_000);

  it("APC05/APC09/APC11: 当前轮 HTML/Markdown 逆序展示、打开，收起偏好在切换会话和 cold resume 后保留", async () => {
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_SOURCE_AND_COLD`;
    await sendV4Prompt(
      `${marker}: create ${SOURCE_HTML_RELATIVE_PATH} and ${SOURCE_MARKDOWN_RELATIVE_PATH}, then report both.`,
    );
    await waitForCompleted(`${marker}_DONE`);
    const targetSession = await waitForBoundSession(marker);

    const expectedTitles = [
      basename(SOURCE_MARKDOWN_RELATIVE_PATH),
      basename(SOURCE_HTML_RELATIVE_PATH),
    ];
    await waitForPreviewCards(expectedTitles);
    await assertSourcePreviewTargets();
    await assertLocalHtmlExternalOpen();

    await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
    await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
    await waitForSidePaneExpanded(true);
    await clickSidePaneToggle();
    await waitForSidePaneExpanded(false);

    await startNewV4Draft();
    const parkingMarker = `${CASE_MARKER}_PARKING`;
    await sendV4Prompt(`${parkingMarker}: complete a parking task before cold resume.`);
    await waitForCompleted(`${parkingMarker}_DONE`);
    const parkingSession = await waitForBoundSession(parkingMarker);
    expect(parkingSession).not.toBe(targetSession);

    await selectV4TaskById(targetSession, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === targetSession && snapshot.timelineText.includes(`${marker}_DONE`),
      `APC11 切回目标 session ${targetSession} 后没有恢复对话`,
      90_000,
    );
    await waitForPreviewCards(expectedTitles, 90_000);
    await waitForSidePaneExpanded(false);
    await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
    await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
    await waitForSidePaneExpanded(true);
    await closeSidePanes();

    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(targetSession, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === targetSession && snapshot.timelineText.includes(`${marker}_DONE`),
      `APC09 cold resume 后没有恢复目标 session ${targetSession}`,
      90_000,
    );
    await waitForPreviewCards(expectedTitles, 90_000);
    await assertSourcePreviewTargets();
  }).timeout(360_000);
});

async function prepareCase(options: { yolo?: boolean } = {}) {
  await prepareV4ConversationE2E();
  if (options.yolo) {
    await switchV4Mode("yolo");
  }
  await rm(CASE_ROOT, { recursive: true, force: true });
  await mkdir(CASE_ROOT, { recursive: true });
}

async function assertLoadedAssistantMedia(count: number) {
  let latest: unknown;
  await browser.waitUntil(
    async () => {
      const values = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLMediaElement>(
            "[data-assistant-media] audio, [data-assistant-media] video",
          ),
        ).map((node) => ({
          ready: node.readyState,
          controls: node.controls,
          autoplay: node.autoplay,
          paused: node.paused,
          source: node.currentSrc,
          error: node.error?.code,
        })),
      );
      latest = values;
      return (
        values.length >= count &&
        values.filter((value) => value.ready > 0 && !value.error).length >= count
      );
    },
    { timeout: 30_000, timeoutMsg: `媒体没有加载元数据: ${JSON.stringify(latest)}` },
  );
  const controls = await browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLMediaElement>(
        "[data-assistant-media] audio, [data-assistant-media] video",
      ),
    ).every((node) => node.controls && !node.autoplay && node.paused),
  );
  expect(controls).toBe(true);
}

async function assertNativeMediaOutsideHistory() {
  const trigger = await browser.$('[data-testid^="chat-assistant-history-trigger-"]');
  expect(await trigger.getAttribute("data-history-open")).toBe("false");
  expect(await browser.$$("[data-conversation-deliverable] [data-assistant-media]")).toHaveLength(
    3,
  );
  const image = await browser.$("[data-conversation-deliverable] img[data-markdown-image]");
  await image.waitForExist();
  await image.scrollIntoView();
  await browser.waitUntil(
    async () => browser.execute((el) => (el as HTMLImageElement).naturalWidth > 0, image),
    { timeout: 30_000 },
  );
}

async function assertNativeMediaVirtualized(marker: string) {
  const historyTurns = 14;
  const paneId = await getV4FocusedPaneId();
  if (!paneId) throw new Error("缺少虚拟滚动验证的当前 pane");
  const turnId = await browser.execute(() => {
    const turn = document.querySelector<HTMLElement>('[data-v4-turn-unit="true"]');
    const image = turn?.querySelector<HTMLImageElement>(
      "[data-conversation-deliverable] img[data-markdown-image]",
    );
    const media = Array.from(
      turn?.querySelectorAll<HTMLMediaElement>(
        "[data-assistant-media] audio, [data-assistant-media] video",
      ) ?? [],
    );
    if (!turn?.dataset.turnId || !image || media.length !== 3) return null;
    (window as NativeMediaProbeWindow).__ux05VirtualizationProbe = {
      turn,
      image,
      media,
      imageSource: image.currentSrc,
      sources: media.map((node) => node.currentSrc),
    };
    return turn.dataset.turnId;
  });
  if (!turnId) throw new Error("缺少已解码的首轮原生媒体节点");
  try {
    if ((await getV4TimelineScrollState(paneId)).hasBackToBottom)
      await clickV4TimelineBackToBottom();
    for (let index = 2; index <= historyTurns; index += 1) {
      const prompt = `E2E_UX05_NATIVE_HISTORY_${String(index).padStart(3, "0")}`;
      await sendV4Prompt(prompt);
      // 每轮等待新 logical turn 的最终正文，避免复用相同 fixture marker 误读旧轮完成。
      await browser.waitUntil(
        async () => {
          const actual = await browser.execute((currentPaneId) => {
            const timeline = document.querySelector(
              `[data-testid="v4-session-pane-${currentPaneId}"] [data-testid="v4-timeline"]`,
            );
            const lastTurn = Array.from(
              timeline?.querySelectorAll('[data-v4-turn-unit="true"]') ?? [],
            ).at(-1);
            return {
              count: Number(timeline?.getAttribute("data-render-unit-count")),
              lastTurnText: lastTurn?.textContent ?? "",
            };
          }, paneId);
          return (
            actual.count === index &&
            actual.lastTurnText.includes(prompt) &&
            actual.lastTurnText.includes(marker)
          );
        },
        { timeout: 30_000, timeoutMsg: `第 ${index} 个原生媒体历史 turn 未完成` },
      );
      await waitForV4Pane(
        (snapshot) => !snapshot.canStop,
        `第 ${index} 个原生媒体 turn 未回到空闲`,
      );
    }
    if ((await getV4TimelineScrollState(paneId)).hasBackToBottom)
      await clickV4TimelineBackToBottom();
    await browser.waitUntil(
      async () =>
        browser.execute((id) => {
          const probe = (window as NativeMediaProbeWindow).__ux05VirtualizationProbe;
          const current = Array.from(document.querySelectorAll('[data-v4-turn-unit="true"]')).find(
            (node) => node.getAttribute("data-turn-id") === id,
          );
          return Boolean(
            probe &&
            !current &&
            !probe.turn.isConnected &&
            !probe.image.isConnected &&
            probe.media.every((node) => !node.isConnected),
          );
        }, turnId),
      { timeout: 15_000, timeoutMsg: "首轮媒体仍在 DOM 中，未证明真实 virtualizer 卸载" },
    );
    const unmounted = await getV4TimelineScrollState(paneId);
    expect(unmounted.renderUnitCount).toBe(historyTurns);
    expect(unmounted.mountedRenderUnitCount).toBeLessThan(historyTurns);
    expect(unmounted.scrollHeight).toBeGreaterThan(unmounted.clientHeight * 2);
    await scrollV4TimelineToTop(paneId);
    await browser.waitUntil(
      async () =>
        browser.execute((id) => {
          const turn = Array.from(document.querySelectorAll('[data-v4-turn-unit="true"]')).find(
            (node) => node.getAttribute("data-turn-id") === id,
          );
          const image = turn?.querySelector<HTMLImageElement>(
            "[data-conversation-deliverable] img[data-markdown-image]",
          );
          const media = Array.from(
            turn?.querySelectorAll<HTMLMediaElement>(
              "[data-assistant-media] audio, [data-assistant-media] video",
            ) ?? [],
          );
          return Boolean(
            image &&
            image.naturalWidth > 0 &&
            media.length === 3 &&
            media.every((node) => node.readyState > 0 && !node.error),
          );
        }, turnId),
      { timeout: 30_000, timeoutMsg: "首轮媒体虚拟滚动重挂后未完成实际解码" },
    );
    const remounted = await browser.execute((id) => {
      const probe = (window as NativeMediaProbeWindow).__ux05VirtualizationProbe!;
      const turn = Array.from(document.querySelectorAll('[data-v4-turn-unit="true"]')).find(
        (node) => node.getAttribute("data-turn-id") === id,
      )!;
      const image = turn.querySelector<HTMLImageElement>(
        "[data-conversation-deliverable] img[data-markdown-image]",
      )!;
      const media = Array.from(
        turn.querySelectorAll<HTMLMediaElement>(
          "[data-assistant-media] audio, [data-assistant-media] video",
        ),
      );
      return {
        newTurn: turn !== probe.turn && !probe.turn.isConnected,
        newImage:
          image !== probe.image &&
          image.currentSrc.startsWith("blob:") &&
          image.currentSrc !== probe.imageSource,
        newMedia: media.every((node) => !probe.media.includes(node)),
        newArtifactSources: media.filter(
          (node) => node.currentSrc.startsWith("blob:") && !probe.sources.includes(node.currentSrc),
        ).length,
        imageWidth: image.naturalWidth,
        media: media.map((node) => ({
          ready: node.readyState,
          controls: node.controls,
          autoplay: node.autoplay,
          paused: node.paused,
        })),
        historyOpen: turn
          .querySelector('[data-testid^="chat-assistant-history-trigger-"]')
          ?.getAttribute("data-history-open"),
      };
    }, turnId);
    expect(remounted.newTurn).toBe(true);
    expect(remounted.newImage).toBe(true);
    expect(remounted.newMedia).toBe(true);
    expect(remounted.newArtifactSources).toBe(2);
    expect(remounted.imageWidth).toBeGreaterThan(0);
    expect(remounted.media).toHaveLength(3);
    expect(
      remounted.media.every(
        (node) => node.ready > 0 && node.controls && !node.autoplay && node.paused,
      ),
    ).toBe(true);
    expect(remounted.historyOpen).toBe("false");
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots) {
      await browser.saveScreenshot(join(screenshots, "ux05-native-virtual-remount.png"));
      await writeFile(
        join(screenshots, "ux05-native-virtual-remount.json"),
        JSON.stringify({ unmounted, remounted }, null, 2),
      );
    }
  } finally {
    await browser.execute(() => {
      delete (window as NativeMediaProbeWindow).__ux05VirtualizationProbe;
    });
  }
}

async function assertNarrowMediaLayout() {
  const previous = await setCurrentElectronRendererContentSize(1280, 900);
  const minimum = await browser.electron.execute((electron, id) => {
    const window = electron.BrowserWindow.fromId(id)!;
    const min = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return min;
  }, previous.windowId);
  try {
    await setCurrentElectronRendererContentSize(430, 900);
    await setExcerptPresentation("en-US", "zai-dark");
    const drawer = await browser.$('[data-testid="workspace-sidebar-drawer-backdrop"]');
    if (await drawer.isDisplayed()) {
      await browser.action("pointer").move({ x: 420, y: 450 }).down().up().perform();
      await drawer.waitForDisplayed({ reverse: true });
    }
    await browser.$("[data-assistant-media]").scrollIntoView();
    const layout = await browser.execute(() => ({
      width: innerWidth,
      media: Array.from(document.querySelectorAll("[data-assistant-media]")).map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    }));
    expect(Math.abs(layout.width - 430)).toBeLessThanOrEqual(1);
    expect(layout.media.length).toBeGreaterThanOrEqual(4);
    for (const item of layout.media) {
      expect(item.left).toBeGreaterThanOrEqual(0);
      expect(item.right).toBeLessThanOrEqual(layout.width + 1);
    }
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots)
      await browser.saveScreenshot(join(screenshots, "ux05-display-dark-en-narrow.png"));
  } finally {
    await browser.electron.execute(
      (electron, id, min) => electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
      previous.windowId,
      minimum,
    );
    await restoreElectronRendererContentSize(previous);
    await setExcerptPresentation("zh-CN", "zai-light");
  }
}

async function installNativeMediaAdapter(contents: Array<Record<string, unknown>>) {
  const bin = process.env.ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN;
  if (!bin || !process.env.PATH?.split(process.platform === "win32" ? ";" : ":").includes(bin))
    throw new Error("需要隔离的官方 CLI 状态夹具 PATH");
  const descriptor = EXTERNAL_ENGINE_RUNTIMES["claude-code"];
  const root = join(resolveE2EStorageRoot(), "engines", managedAdapterInstallDirName(descriptor));
  const entry = join(root, ...managedAdapterEntrySegments(descriptor));
  await mkdir(dirname(entry), { recursive: true });
  const script = (
    await readFile(
      new URL(
        "../../../../../apps/zcode-cli/packages/bootstrap/tests/fixtures/native-subagents/acp-fixture.cjs",
        import.meta.url,
      ),
      "utf8",
    )
  )
    .replace("process.env.FIXTURE_FRAMES", "require('node:path').join(__dirname,'frames.json')")
    .replace(
      "process.env.FIXTURE_LOG",
      "require('node:path').join(__dirname,'client-messages.jsonl')",
    );
  await writeFile(entry, script);
  await writeFile(
    join(dirname(entry), "frames.json"),
    JSON.stringify({
      mainSessionId: "ux05-native",
      prompt: contents.map((content) => ({
        update: { sessionUpdate: "agent_message_chunk", content },
      })),
      load: [],
    }),
  );
  await writeFile(
    join(root, "node_modules", ...descriptor.adapterPackage.split("/"), "package.json"),
    JSON.stringify({ version: descriptor.adapterVersion }),
  );
}

function createFixtureWav() {
  const wav = Buffer.alloc(8044, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(8036, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(8000, 40);
  return wav;
}

async function waitForCompleted(marker: string) {
  await waitForV4AssistantMessageContaining(marker, 90_000);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(marker),
    `Assistant Preview Cards turn 没有完成: ${marker}`,
    90_000,
  );
}

async function waitForBoundSession(marker: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) =>
      current.sessionId !== null &&
      current.sessionId !== "draft" &&
      !current.canStop &&
      current.timelineText.includes(marker),
    `Assistant Preview Cards 缺少已绑定 session: ${marker}`,
    60_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`Assistant Preview Cards 得到无效 sessionId: ${snapshot.sessionId ?? "null"}`);
  }
  return snapshot.sessionId;
}

async function readPreviewCards(
  expectedTitles: readonly string[] = [],
): Promise<PreviewCardSnapshot[]> {
  return browser.execute(
    (titles) => {
      const openLabels = new Set(["Open", "打开", "Preview", "预览"]);
      return Array.from(
        document.querySelectorAll<HTMLElement>('[data-zcode-stream-animate="true"]'),
      )
        .filter((row) =>
          Array.from(row.querySelectorAll<HTMLButtonElement>("button")).some((button) =>
            openLabels.has((button.textContent ?? "").trim()),
          ),
        )
        .map((row) => {
          const text = row.innerText.replace(/\u00a0/g, " ").trim();
          const title = titles.find((candidate) => text.includes(candidate)) ?? "";
          return { text, title };
        });
    },
    [...expectedTitles],
  );
}

async function waitForPreviewCards(expectedTitles: readonly string[], timeout = 60_000) {
  let latest: PreviewCardSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readPreviewCards(expectedTitles);
      return (
        latest.length === expectedTitles.length &&
        latest.every((card, index) => card.title === expectedTitles[index])
      );
    },
    {
      timeout,
      timeoutMsg: `预览卡片没有按预期收敛: expected=${JSON.stringify(expectedTitles)} latest=${JSON.stringify(latest)}`,
    },
  );
}

async function expectPreviewCardMissing(title: string) {
  const cards = await readPreviewCards([title]);
  expect(cards.some((card) => card.title === title)).toBe(false);
}

async function clickPreviewCard(title: string) {
  const result = await browser.execute((expectedTitle) => {
    const openLabels = new Set(["Open", "打开", "Preview", "预览"]);
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-zcode-stream-animate="true"]'),
    ).find((candidate) => candidate.innerText.includes(expectedTitle));
    const button = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => openLabels.has((candidate.textContent ?? "").trim()),
    );
    button?.click();
    return { clicked: Boolean(button), disabled: Boolean(button?.disabled) };
  }, title);
  expect(result.clicked).toBe(true);
  expect(result.disabled).toBe(false);
}

async function assertFileOpenApps(filename: string) {
  const path = join(CASE_ROOT, filename);
  const expected = await browser.execute(async (filePath) => {
    const platform = (
      window as unknown as Window & {
        zcode: { getInstalledEditors(path?: string): Promise<Array<{ name: string }>> };
      }
    ).zcode;
    const apps = await platform.getInstalledEditors(filePath);
    const base = await platform.getInstalledEditors();
    return { apps: apps.map((app) => app.name), base: base.map((app) => app.name) };
  }, path);
  const rows = await browser.$$('[data-zcode-stream-animate="true"]');
  const row = (
    await rows.map(async (candidate) => ({ candidate, text: await candidate.getText() }))
  ).find((item) => item.text.includes(filename))?.candidate;
  expect(row).toBeDefined();
  await row?.$('button[aria-label="Choose app"], button[aria-label="选择打开方式"]').click();
  await browser.waitUntil(
    async () => {
      const names = await browser
        .$$('[role="menuitem"] img')
        .map((item) => item.getAttribute("alt"));
      return (
        expected.apps.every((name) => names.includes(name)) && names.length === expected.apps.length
      );
    },
    { timeout: 10_000, timeoutMsg: `${filename} 打开方式没有匹配平台应用清单` },
  );
  const text = await browser.$('[role="menu"]').getText();
  expect(text).toMatch(/Copy absolute path|复制绝对路径/);
  expect(text).toMatch(/Copy relative path|复制相对路径/);
  expect(text).not.toMatch(/选择其他应用|Choose another app|系统默认应用/);
  expect(expected.apps).toEqual(expect.arrayContaining(expected.base));
  if (process.platform === "darwin" && filename.endsWith(".pdf")) {
    expect(expected.apps).toContain("Preview");
    expect(expected.base).not.toContain("Preview");
  }
  await browser.keys("Escape");
}

async function assertLocalHtmlExternalOpen() {
  const openPath = await browser.electron.mock("shell", "openPath");
  await openPath.mockResolvedValue("");
  try {
    const expectedTitle = basename(SOURCE_HTML_RELATIVE_PATH);
    const rows = await browser.$$('[data-zcode-stream-animate="true"]');
    const row = (
      await rows.map(async (candidate) => ({
        candidate,
        text: await candidate.getText(),
      }))
    ).find(({ text }) => text.includes(expectedTitle))?.candidate;
    expect(row).toBeDefined();
    const trigger = await row?.$(
      'button[aria-label="Choose app"], button[aria-label="选择打开方式"]',
    );
    expect(trigger).toBeDefined();
    await trigger?.click();

    await browser.waitUntil(
      async () => {
        const labels = new Set(["Open in browser", "在浏览器中打开"]);
        const items = await browser.$$('[role="menuitem"]');
        const item = (
          await items.map(async (candidate) => ({
            candidate,
            text: await candidate.getText(),
          }))
        ).find(({ text }) => labels.has(text.trim()))?.candidate;
        if (!item) return false;
        await item.click();
        return true;
      },
      { timeout: 10_000, timeoutMsg: "本地 HTML 卡片没有显示外部浏览器入口" },
    );

    await browser.waitUntil(
      async () => {
        try {
          await expect(openPath).toHaveBeenCalledWith(await realpath(SOURCE_HTML_PATH));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, timeoutMsg: "本地 HTML 没有通过 shell.openPath 打开" },
    );
  } finally {
    await browser.electron.restoreAllMocks();
  }
}

async function clickSidePaneToggle() {
  const clicked = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        ["收起侧边面板", "Collapse side pane", "展开侧边面板", "Expand side pane"].includes(
          candidate.getAttribute("aria-label") ?? "",
        ),
    );
    button?.click();
    return Boolean(button);
  });
  expect(clicked).toBe(true);
}

async function waitForSidePaneExpanded(expectedExpanded: boolean) {
  let latestLabel = "";
  await browser.waitUntil(
    async () => {
      latestLabel = await browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) =>
            ["收起侧边面板", "Collapse side pane", "展开侧边面板", "Expand side pane"].includes(
              candidate.getAttribute("aria-label") ?? "",
            ),
        );
        return button?.getAttribute("aria-label") ?? "";
      });
      const isExpanded = ["收起侧边面板", "Collapse side pane"].includes(latestLabel);
      return isExpanded === expectedExpanded;
    },
    {
      timeout: 15_000,
      timeoutMsg: `side pane 展开状态不符合预期: expected=${expectedExpanded}, label=${latestLabel}`,
    },
  );
}

async function waitForBrowserSurface(expectedUrl: string, bodyMarker: string) {
  let latest = { address: "", webContentsId: 0 };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (addressTestId, webviewTestId) => {
          const address = document.querySelector<HTMLInputElement>(
            `[data-testid="${addressTestId}"]`,
          );
          const webview = document.querySelector<HTMLElement>(`[data-testid="${webviewTestId}"]`) as
            | (HTMLElement & { getWebContentsId?: () => number })
            | null;
          return {
            address: address?.value ?? "",
            webContentsId: webview?.getWebContentsId?.() ?? 0,
          };
        },
        TID_BROWSER_ADDRESS_INPUT,
        TID_BROWSER_WEBVIEW,
      );
      return latest.webContentsId > 0 && new URL(latest.address).href === new URL(expectedUrl).href;
    },
    {
      timeout: 60_000,
      timeoutMsg: `Browser Pane 没有打开目标 URL: ${JSON.stringify(latest)}`,
    },
  );

  let latestBody = "";
  await browser.waitUntil(
    async () => {
      latestBody = await browser.electron.execute(async (electron, webContentsId) => {
        const contents = electron.webContents.fromId(webContentsId);
        if (!contents || contents.isDestroyed()) return "";
        return contents.executeJavaScript("document.body?.innerText ?? ''");
      }, latest.webContentsId);
      return latestBody.includes(bodyMarker);
    },
    {
      timeout: 60_000,
      timeoutMsg: `Browser webview 没有加载页面 marker ${bodyMarker}: ${latestBody}`,
    },
  );
}

async function waitForPreviewRenderer(
  filename: string,
  renderer: "docx" | "excel" | "pptx" | "pdf" | "markdown" | "audio" | "video",
) {
  let latest = { hasError: false, header: "", ready: false, text: "" };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (previewTestId, expectedFilename, expectedRenderer) => {
          const pane = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${previewTestId}"]`),
          ).find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.left < window.innerWidth && rect.right > 0;
          });
          const text = (
            (pane?.closest<HTMLElement>("[data-file-manager-pane]") ?? pane)?.innerText ?? ""
          ).replace(/\u00a0/g, " ");
          const hasError = Boolean(pane?.querySelector('[role="alert"]'));
          const rect = pane?.getBoundingClientRect();
          const visible = Boolean(rect && rect.width > 160 && rect.height > 80);
          let ready = false;
          if (expectedRenderer === "docx" || expectedRenderer === "excel") {
            ready = Boolean(
              pane?.querySelector(`[data-office-preview-kind="${expectedRenderer}"]`),
            );
          } else if (expectedRenderer === "pptx") {
            ready = Boolean(pane?.querySelector("aside[aria-label] button[aria-label]"));
          } else if (expectedRenderer === "pdf") {
            ready = Boolean(pane?.querySelector(".react-pdf__Document .react-pdf__Page"));
          } else if (expectedRenderer === "audio") {
            ready = Boolean(pane?.querySelector("audio[controls]"));
          } else if (expectedRenderer === "video") {
            ready = Boolean(pane?.querySelector("video[controls][playsinline]"));
          } else {
            ready = text.includes("APC05 Markdown renderer marker");
          }
          return {
            hasError,
            header: text.split("\n")[0] ?? "",
            ready: ready && visible,
            text,
          };
        },
        TID_PREVIEW_PANE,
        filename,
        renderer,
      );
      return !latest.hasError && latest.text.includes(filename) && latest.ready;
    },
    {
      timeout: 90_000,
      timeoutMsg: `Preview Pane renderer 没有就绪: ${filename}/${renderer}; latest=${JSON.stringify(latest)}`,
    },
  );
}

async function assertPreviewVideoSurvivesResizeAndFullscreen() {
  const videoReady = await browser.execute(() => {
    const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
    if (!video) return false;
    const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
    probeWindow.__zcodePreviewVideo = video;
    window.dispatchEvent(new Event("resize"));
    return true;
  });
  expect(videoReady).toBe(true);

  // resize settling 的 state update 应该已经完成；媒体节点不能被替换或卸载。
  await browser.pause(80);
  const sameVideoAfterResize = await browser.execute(() => {
    const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
    return (
      document.querySelector<HTMLVideoElement>("video[controls][playsinline]") ===
      probeWindow.__zcodePreviewVideo
    );
  });
  expect(sameVideoAfterResize).toBe(true);

  const fullscreenResult = await browser.executeAsync((done) => {
    const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
    if (!video?.requestFullscreen) {
      done("unsupported");
      return;
    }
    const finish = () => {
      document.removeEventListener("fullscreenchange", finish);
      done(document.fullscreenElement === video ? "entered" : "not-entered");
    };
    document.addEventListener("fullscreenchange", finish, { once: true });
    void video.requestFullscreen().catch(() => {
      document.removeEventListener("fullscreenchange", finish);
      done("unsupported");
    });
  });
  if (fullscreenResult === "entered") {
    await browser.pause(500);
    const sameVideoInFullscreen = await browser.execute(() => {
      const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
      const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
      return video === probeWindow.__zcodePreviewVideo && document.fullscreenElement === video;
    });
    expect(sameVideoInFullscreen).toBe(true);
    await browser.execute(() => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    });
  }
}

async function assertSourcePreviewTargets() {
  await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
  await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
  await closePreviewPane();

  await clickPreviewCard(basename(SOURCE_HTML_RELATIVE_PATH));
  await waitForBrowserSurface(new URL(`file://${SOURCE_HTML_PATH}`).href, "APC05_HTML_PAGE");
  await closeSidePanes();
}

async function materializeOfficeFixtures() {
  const officeRoot = join(CASE_ROOT, "office");
  await mkdir(officeRoot, { recursive: true });
  await Promise.all(
    OFFICE_FILES.map((item) =>
      copyFile(join(OFFICE_FIXTURE_ROOT, item.fixture), join(officeRoot, item.name)),
    ),
  );
}

async function materializeMediaFixtures() {
  const mediaRoot = join(CASE_ROOT, "media");
  await mkdir(mediaRoot, { recursive: true });
  const videoFixture = await readFile(
    new URL("../fixtures/media/sample-video.mp4", import.meta.url),
  );
  const largeVideo = Buffer.concat([
    videoFixture,
    Buffer.alloc(Math.max(0, 8 * 1024 * 1024 + 1 - videoFixture.length)),
  ]);
  const wav = Buffer.alloc(45);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(37, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(1, 40);
  wav[44] = 128;
  await Promise.all([
    writeFile(join(mediaRoot, "生成 视频.mp4"), largeVideo),
    writeFile(join(mediaRoot, "生成 音频.wav"), wav),
  ]);
  expect((await stat(join(mediaRoot, "生成 视频.mp4"))).size).toBeGreaterThan(8 * 1024 * 1024);
}

async function materializeStaleSourceFiles() {
  const staleRoot = join(CASE_ROOT, "stale");
  await mkdir(staleRoot, { recursive: true });
  await Promise.all([
    writeFile(join(staleRoot, "旧 页面.html"), "<p>stale html</p>", "utf8"),
    writeFile(join(staleRoot, "旧 说明.md"), "stale markdown", "utf8"),
  ]);
}

async function assertLocalMediaPreviewLogs(snapshot: Map<string, number>): Promise<void> {
  const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
  if (!runtimeLogDir) {
    throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
  }

  let desktopLogs = "";
  await browser.waitUntil(
    async () => {
      desktopLogs = await readDesktopRuntimeLogsSince(runtimeLogDir, snapshot);
      return (
        desktopLogs.includes("[rpc:call] media-preview.prepare OK") &&
        desktopLogs.includes("local media preview path authorization OK")
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `本地媒体预览日志没有完成: ${desktopLogs}`,
    },
  );
  expect(desktopLogs).not.toContain("[rpc:call] file.readMediaPreview");
}

async function snapshotDesktopRuntimeLogs(): Promise<Map<string, number>> {
  const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
  if (!runtimeLogDir) {
    throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
  }
  const entries = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
  const snapshot = new Map<string, number>();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => {
        snapshot.set(entry.name, (await stat(join(runtimeLogDir, entry.name))).size);
      }),
  );
  return snapshot;
}

async function readDesktopRuntimeLogsSince(
  runtimeLogDir: string,
  snapshot: Map<string, number>,
): Promise<string> {
  const entries = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => entry.name)
    .sort();
  const contents = await Promise.all(
    logFiles.map(async (fileName) => {
      const content = await readFile(join(runtimeLogDir, fileName));
      const offset = Math.min(snapshot.get(fileName) ?? 0, content.byteLength);
      return content.subarray(offset).toString("utf8");
    }),
  );
  return contents.join("\n");
}

async function materializeBoundFiles() {
  const boundsRoot = join(CASE_ROOT, "bounds");
  await mkdir(boundsRoot, { recursive: true });
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      writeFile(
        join(boundsRoot, `max-${String(index + 1).padStart(2, "0")}.pdf`),
        "exists",
        "utf8",
      ),
    ),
    writeFile(join(boundsRoot, "nofill-01.pdf"), "excluded existing candidate", "utf8"),
    ...Array.from({ length: 9 }, (_, index) =>
      writeFile(
        join(boundsRoot, `nofill-${String(index + 8).padStart(2, "0")}.pdf`),
        "exists",
        "utf8",
      ),
    ),
  ]);
}

async function closePreviewPane() {
  // Bug 根因：PreviewPane 自身没有关闭按钮，关闭动作属于外层 side-pane tab。
  // 必须关闭当前激活 tab 并等待旧 pane 卸载，否则下一次点击卡片仍会看到旧 renderer。
  const closed = await browser.execute(() => {
    const activeTab = document.querySelector<HTMLElement>("[data-side-pane-tab-id][data-active]");
    const closeButton = activeTab?.querySelector<HTMLButtonElement>("button");
    closeButton?.click();
    return Boolean(closeButton);
  });
  expect(closed).toBe(true);
  await browser.waitUntil(
    async () =>
      !(await browser.execute(
        (previewTestId) => Boolean(document.querySelector(`[data-testid="${previewTestId}"]`)),
        TID_PREVIEW_PANE,
      )),
    {
      timeout: 10_000,
      timeoutMsg: "Preview Pane 点击关闭后没有卸载",
    },
  );
}

async function closeSidePanes() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const tab =
          document.querySelector<HTMLElement>("[data-side-pane-tab-id][data-active]") ??
          document.querySelector<HTMLElement>("[data-side-pane-tab-id]");
        const closeButton = tab?.querySelector<HTMLButtonElement>("button");
        if (!closeButton) return true;
        closeButton.click();
        return false;
      }),
    {
      interval: 100,
      timeout: 10_000,
      timeoutMsg: "Assistant Preview Cards 清理 side pane tabs 超时",
    },
  );
}

function createFixtureServer(): Server {
  return createServer((request, response) => {
    const path = request.url?.split("?", 1)[0] ?? "";
    if (path.endsWith("-retry.wav") && !retryMediaAvailable) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (path.endsWith(".wav") || path.endsWith("-download")) {
      response.setHeader("content-type", "audio/wav");
      response.end(createFixtureWav());
      return;
    }
    if (path.endsWith(".mp4")) {
      response.setHeader("content-type", "video/mp4");
      response.end(fixtureVideo);
      return;
    }
    if (path.endsWith(".png")) {
      response.setHeader("content-type", "image/png");
      response.end(fixtureImage);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><html><head><title>APC01 Local Preview</title></head><body>APC01_LOCAL_URL_PAGE</body></html>",
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/assistant-preview`;
}

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
