import {
  TID_TASK_ITEM,
  TID_WORKSPACE_HEADER,
  TID_WORKSPACE_PATH,
  TID_WORKSPACE_TITLE,
  TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB,
  TID_SIDE_PANE_TOGGLE,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_V4_MODEL_CONFIG,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { encodeCustomModelValue } from "@zcode/shared";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Key } from "webdriverio";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "../helpers/desktop-app.js";
import {
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
  selectV4TaskById,
  startNewV4Draft,
  getV4FocusedPaneId,
} from "../helpers/v4-conversation.js";
import {
  ensureUpstreamProviderForE2E,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_THOUGHT_LEVEL,
} from "../helpers/upstream-provider.js";
import { ensureProjectExpanded } from "../helpers/project-sidebar.js";
import {
  TASK_TITLE_MARQUEE_LONG_ID,
  TASK_TITLE_MARQUEE_PINNED_ID,
  TASK_TITLE_MARQUEE_SHORT_ID,
} from "../helpers/task-title-marquee-fixture.js";

const CASE_TIMEOUT_MS = 180_000;

interface TitleSnapshot {
  animationCount: number;
  copyCount: number;
  duplicateAriaHidden: string | null;
  maskImage: string;
  nativeTitle: string | null;
  overflow: boolean;
  rowWidth: number;
  titleWidth: number;
  trackWidth: number;
}

describe("TTL：Task 名称溢出走马灯", () => {
  before(async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    await waitForTask(TASK_TITLE_MARQUEE_LONG_ID);
  });

  afterEach(async () => {
    await setReducedMotion(false);
    await browser.execute(() => document.documentElement.classList.remove("dark"));
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TTL01：短标题不挂载 mask、副本、动画或原生 title", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    const snapshot = await readTitleSnapshot(TASK_TITLE_MARQUEE_SHORT_ID);
    expect(snapshot.overflow).toBe(false);
    expect(snapshot.copyCount).toBe(1);
    expect(snapshot.maskImage).toBe("none");
    expect(snapshot.nativeTitle).toBe(null);
    await hoverTaskRow(TASK_TITLE_MARQUEE_SHORT_ID);
    expect((await readTitleSnapshot(TASK_TITLE_MARQUEE_SHORT_ID)).animationCount).toBe(0);
  });

  it("TTL02：Project 长标题仅在溢出时显示 24px mask，整行非文字区域 hover 启动动画", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    const beforeHover = await readTitleSnapshot(TASK_TITLE_MARQUEE_LONG_ID);
    expect(beforeHover.overflow).toBe(true);
    expect(beforeHover.copyCount).toBe(2);
    expect(beforeHover.duplicateAriaHidden).toBe("true");
    expect(beforeHover.maskImage).toContain("24px");
    expect(beforeHover.nativeTitle).toBe(null);

    const hoveredOutsideTitle = await hoverTaskRow(TASK_TITLE_MARQUEE_LONG_ID);
    expect(hoveredOutsideTitle).toBe(true);
    await waitForAnimationCount(TASK_TITLE_MARQUEE_LONG_ID, 2);
  });

  it("TTL03：主体尾部到达左边缘时 mask 直接切换，副本头部对齐后停留 2 秒再循环", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await hoverTaskRow(TASK_TITLE_MARQUEE_LONG_ID);
    // Bug 根因：重复 mouseenter 会先取消上一条 case 留下的动画，再经过 1 秒
    // hover delay 创建新动画；立即读取会落在 effect 为空的竞态窗口。
    await waitForAnimationCount(TASK_TITLE_MARQUEE_LONG_ID, 2);
    const timeline = await readAnimationTimeline(TASK_TITLE_MARQUEE_LONG_ID);
    expect(timeline.animations).toHaveLength(2);
    expect(timeline.trackOffsets).toHaveLength(3);
    expect(timeline.maskOffsets).toHaveLength(5);
    expect(timeline.maskOffsets[2]).toBeCloseTo(timeline.maskOffsets[3] ?? -1, 8);
    expect(timeline.maskFrames[2]).toContain("transparent 0px");
    expect(timeline.maskFrames[3]).toContain("black 0px");
    expect(timeline.pauseMs).toBeCloseTo(2_000, -1);
    expect(timeline.distance).toBeCloseTo(timeline.originalWidth + 24, 0);
    expect(timeline.finalTransform).toBe(timeline.movementTransform);
  });

  it("TTL04：mouseleave 立即复位，再次 hover 从起点重新滚动", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await hoverTaskRow(TASK_TITLE_MARQUEE_LONG_ID);
    await waitForAnimationCount(TASK_TITLE_MARQUEE_LONG_ID, 2);
    await setAnimationCurrentTime(TASK_TITLE_MARQUEE_LONG_ID, 2_000);
    await leaveTaskRow(TASK_TITLE_MARQUEE_LONG_ID);
    const reset = await readTitleSnapshot(TASK_TITLE_MARQUEE_LONG_ID);
    expect(reset.animationCount).toBe(0);
    expect(reset.maskImage).toContain("calc(100% - 24px)");
    await hoverTaskRow(TASK_TITLE_MARQUEE_LONG_ID);
    await waitForAnimationCount(TASK_TITLE_MARQUEE_LONG_ID, 2);
    const restarted = await readAnimationTimeline(TASK_TITLE_MARQUEE_LONG_ID);
    expect(restarted.currentTimes.every((time) => time < 500)).toBe(true);
  });

  it("TTL05：ResizeObserver 驱动 fit → overflow → fit，并同步副本与 mask", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await setTitleProbeWidth(TASK_TITLE_MARQUEE_LONG_ID, 2_000);
    await waitForOverflow(TASK_TITLE_MARQUEE_LONG_ID, false);
    expect((await readTitleSnapshot(TASK_TITLE_MARQUEE_LONG_ID)).copyCount).toBe(1);
    await setTitleProbeWidth(TASK_TITLE_MARQUEE_LONG_ID, 100);
    await waitForOverflow(TASK_TITLE_MARQUEE_LONG_ID, true);
    expect((await readTitleSnapshot(TASK_TITLE_MARQUEE_LONG_ID)).copyCount).toBe(2);
    await setTitleProbeWidth(TASK_TITLE_MARQUEE_LONG_ID, 2_000);
    await waitForOverflow(TASK_TITLE_MARQUEE_LONG_ID, false);
    await setTitleProbeWidth(TASK_TITLE_MARQUEE_LONG_ID, null);
    await waitForOverflow(TASK_TITLE_MARQUEE_LONG_ID, true);
  });

  it("TTL06：reduced-motion 下保留静态溢出提示但不启动动画", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await setReducedMotion(true);
    await hoverTaskRow(TASK_TITLE_MARQUEE_LONG_ID);
    const snapshot = await readTitleSnapshot(TASK_TITLE_MARQUEE_LONG_ID);
    expect(snapshot.overflow).toBe(true);
    expect(snapshot.copyCount).toBe(2);
    expect(snapshot.animationCount).toBe(0);
  });

  it("TTL07：项目任务行、全局置顶区与深色主题复用相同溢出语义", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    // Timeline / Group 视图已随虚拟项目重构下线；剩余展示形态是项目树任务行与全局置顶区。
    await assertOverflowSurface(TASK_TITLE_MARQUEE_LONG_ID);
    await assertOverflowSurface(TASK_TITLE_MARQUEE_PINNED_ID);
    await browser.execute(() => document.documentElement.classList.add("dark"));
    await assertOverflowSurface(TASK_TITLE_MARQUEE_PINNED_ID);

    // 任务标题上下文入口：打开任务后，工作区图标位于名称前，hover/点按均可查看信息。
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    const task = await $(`[data-testid="${testId(TID_TASK_ITEM, TASK_TITLE_MARQUEE_SHORT_ID)}"]`);
    await task.click();
    const icon = await $(
      `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_WORKSPACE_PATH}"]`,
    );
    await icon.waitForDisplayed({ timeout: 15000 });
    // 当前工作台合同：真实会话只读展示所属项目；旧 workspace button/hover popup 已退场。
    expect(await icon.getTagName()).toBe("span");
    expect(await icon.getText()).toBe("ZCodeProject");
    expect(await icon.getAttribute("title")).toBe(DEFAULT_WORKSPACE);
    expect(await icon.getAttribute("data-workspace-abs-path")).toBe(DEFAULT_WORKSPACE);
    expect(await icon.$("button").isExisting()).toBe(false);
    expect(
      await browser.execute(
        (pathId, titleId) => {
          const icon = document.querySelector(`[data-testid="${pathId}"]`)!;
          const title = document.querySelector(`[data-testid="${titleId}"]`)!;
          return Boolean(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING);
        },
        TID_WORKSPACE_PATH,
        TID_WORKSPACE_TITLE,
      ),
    ).toBe(true);
    expect(await $("[data-workspace-header-branch]").isExisting()).toBe(false);
  });
  it("UX09：生成、侧栏键盘重命名、刷新和冷恢复后栏头与菜单同名", async function () {
    this.timeout(240_000);
    await prepareUx09Draft();
    await sendV4Prompt("E2E_UX09_TITLE_SEED 建立标题一致性会话");
    await waitForV4TimelineContaining("UX09_TITLE_SEED_OK", 45_000);
    const session = await waitForV4Pane(
      (s) => Boolean(s.sessionId && s.sessionId !== "draft"),
      "UX09 会话没有建立",
    );
    const id = session.sessionId!;
    await waitForUnifiedTitle(id, "UX09 自动生成的完整会话标题");

    const row = await $(`[data-testid="${testId(TID_TASK_ITEM, id)}"]`);
    await row.click({ button: "right" });
    // 入口固定在侧栏任务右键菜单；只在已可见菜单中按当前语言选择。
    const items = await $$('[role="menuitem"]');
    let selected = false;
    for (const item of items) {
      if (/^(重命名任务|Rename task)$/u.test(await item.getText())) {
        await item.click();
        selected = true;
        break;
      }
    }
    expect(selected).toBe(true);
    const input = await $('[role="dialog"] input');
    await input.waitForDisplayed();
    const custom =
      "UX09 手动命名后的完整会话标题 Long title remains available in every workbench entry";
    await input.setValue(custom);
    expect(await $(`[data-testid="${TID_WORKSPACE_TITLE}"]`).getAttribute("title")).not.toBe(
      custom,
    );
    expect(await input.isFocused()).toBe(true);
    await browser.keys(Key.Enter);
    await input.waitForDisplayed({ reverse: true });
    await waitForUnifiedTitle(id, custom);
    await browser.refresh();
    await waitForUnifiedTitle(id, custom);
    await browser.reloadSession();
    await selectV4TaskById(id, 45_000);
    await waitForV4TimelineContaining("UX09_TITLE_SEED_OK", 45_000);
    await waitForUnifiedTitle(id, custom);
    await verifyUx09Appearance(id, custom);
    await startNewV4Draft();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_WORKSPACE_TITLE}"]`).getAttribute("title")) === "新会话",
      { timeout: 15_000 },
    );
    await assertWorkbenchMenuTitle("新会话");
  });
});

async function prepareUx09Draft() {
  await prepareV4ConversationE2E({ skipProvider: true });
  await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  const paneId = await getV4FocusedPaneId();
  expect(paneId).toBeTruthy();
  const pane = await $(`[data-testid="${testId(TID_V4_SESSION_PANE, paneId!)}"]`);
  const config = await pane.$(`[data-testid="${TID_V4_MODEL_CONFIG}"]`);
  const trigger = await pane.$(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
  // 旧会话保持挂载时会有多个同名控件；只从真实焦点 pane 打开当前菜单。
  await trigger.waitForClickable();
  await trigger.click();
  const provider = await $('[data-testid="composer-provider-trigger"]');
  await provider.waitForDisplayed();
  await provider.moveTo();
  const group = await $(
    `[data-testid="${testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${UPSTREAM_PROVIDER_ID}`)}"]`,
  );
  await group.waitForClickable();
  await group.click();
  const model = await $(
    `[data-testid="${testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL))}"]`,
  );
  await model.waitForClickable();
  await model.click();
  await browser.waitUntil(async () => (await config.getAttribute("data-model")) === UPSTREAM_MODEL);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  if (UPSTREAM_THOUGHT_LEVEL) {
    const slider = await $('[data-testid="composer-thought-slider"]');
    await slider.waitForDisplayed();
    const levels = JSON.parse((await slider.getAttribute("data-levels"))!) as string[];
    const target = levels.indexOf(UPSTREAM_THOUGHT_LEVEL);
    expect(target).toBeGreaterThanOrEqual(0);
    if (Number(await slider.getValue()) !== target) {
      await slider.click();
      await browser.keys(Key.Home);
      await browser.waitUntil(async () => Number(await slider.getValue()) === 0);
      for (let index = 0; index < target; index++) {
        await browser.waitUntil(
          async () => (await slider.getAttribute("aria-disabled")) === "false",
        );
        await browser.keys(Key.ArrowRight);
        await browser.waitUntil(async () => Number(await slider.getValue()) === index + 1);
      }
    }
    await browser.waitUntil(
      async () => (await config.getAttribute("data-thought")) === UPSTREAM_THOUGHT_LEVEL,
    );
  }
  await browser.keys(Key.Escape);
}

async function waitForUnifiedTitle(sessionId: string, title: string) {
  await browser.waitUntil(
    async () => {
      const heading = await $(`[data-testid="${TID_WORKSPACE_TITLE}"]`);
      const row = await $(
        `[data-testid="${testId(TID_TASK_ITEM, sessionId)}"] [data-task-title-copy="original"]`,
      );
      return (await heading.getAttribute("title")) === title && (await row.getText()) === title;
    },
    { timeout: 45_000, timeoutMsg: `UX09 栏头/侧栏未同步为 ${title}` },
  );
  await assertWorkbenchMenuTitle(title);
}

async function assertWorkbenchMenuTitle(title: string, screenshotName?: string) {
  const trigger = await $('[data-testid="workbench-layout-menu"]');
  await trigger.click();
  await browser.waitUntil(async () => (await trigger.getAttribute("data-state")) === "open");
  await browser.keys(Key.Escape);
  // Radix 关闭动画后才恢复触发器焦点；原生按键须等待该可观察屏障，不能程序 focus。
  await browser.waitUntil(() => trigger.isFocused(), {
    timeoutMsg: "UX09 Escape 未将焦点还给布局入口",
  });
  await browser.keys(Key.Enter);
  // 菜单条目不再挂原生 title（会遮挡走马灯），按原始标题副本的文本定位。
  let itemId = "";
  await browser.waitUntil(
    async () => {
      itemId = await browser.execute((expected) => {
        const match = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid^="workbench-activate-tab-"]'),
        ).find(
          (node) =>
            node.querySelector('[data-task-title-copy="original"]')?.textContent === expected,
        );
        return match?.dataset.testid ?? "";
      }, title);
      return Boolean(itemId);
    },
    { timeout: 10_000, timeoutMsg: `布局菜单缺少标题 ${title}` },
  );
  const item = await $(`[data-testid="${itemId}"]`);
  await item.waitForDisplayed();
  const layout = await browser.execute((node) => {
    const rect = node.getBoundingClientRect();
    const original = node.querySelector<HTMLElement>('[data-task-title-copy="original"]')!;
    const text = original.parentElement!.parentElement as HTMLElement;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 20;
    return {
      left: rect.left,
      right: rect.right,
      width: innerWidth,
      textWidth: text.clientWidth,
      textHeight: text.getBoundingClientRect().height,
      lineHeight,
      whiteSpace: getComputedStyle(text).whiteSpace,
      overflowing: text.classList.contains("task-title-marquee"),
      nativeTitle: node.getAttribute("title"),
      text: node.textContent ?? "",
    };
  }, item);
  // 回归：长标题曾折成多行导致列表错乱；“左栏/右栏”前缀已移除。
  expect(layout.textWidth).toBeGreaterThan(0);
  expect(layout.whiteSpace).toBe("nowrap");
  expect(layout.textHeight).toBeLessThanOrEqual(layout.lineHeight * 1.5);
  expect(layout.nativeTitle).toBe(null);
  expect(layout.text).not.toMatch(/左栏|右栏|Left column|Right column/u);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width + 1);
  if (layout.overflowing) {
    await item.moveTo();
    await browser.waitUntil(
      () =>
        browser.execute(
          (node) => node.getAnimations({ subtree: true }).length >= 2,
          item as unknown as HTMLElement,
        ),
      { timeout: 5_000, timeoutMsg: "布局菜单长标题悬停后未启动走马灯" },
    );
  }
  if (screenshotName && process.env.ZCODE_E2E_ARTIFACT_DIR)
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR, screenshotName));
  await browser.keys(Key.Escape);
  await browser.waitUntil(async () => (await trigger.getAttribute("data-state")) !== "open");
}

async function verifyUx09Appearance(id: string, title: string) {
  const original = await setCurrentElectronRendererContentSize(1280, 900);
  const minimum = await browser.electron.execute((electron, windowId) => {
    const window = electron.BrowserWindow.fromId(windowId)!;
    const old = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return old;
  }, original.windowId);
  const platformWindow = await browser.electron.execute(
    (electron, windowId) => ({
      isMacDesktop: process.platform === "darwin",
      isMacFullscreen: electron.BrowserWindow.fromId(windowId)!.isFullScreen(),
    }),
    original.windowId,
  );
  // SidePane 无更新按钮；按当前平台/fullscreen 合同验收，不能将 Windows 的 88px 套到 macOS。
  const compactLeadingPadding =
    platformWindow.isMacDesktop && !platformWindow.isMacFullscreen ? 168 : 88;
  const fullViewShortcut = [platformWindow.isMacDesktop ? "Command" : "Control", "Shift", "f"];
  try {
    for (const [locale, theme, width] of [
      ["zh-CN", "zai-light", 1280],
      ["en-US", "zai-dark", 430],
    ] as const) {
      await browser.execute(
        (language, color) => {
          const actions = (
            window as unknown as {
              __testActions: { setLocale(value: string): void; setTheme(value: string): void };
            }
          ).__testActions;
          actions.setLocale(language);
          actions.setTheme(color);
        },
        locale,
        theme,
      );
      await setCurrentElectronRendererContentSize(width, 900);
      const drawer = await $('[data-testid="workspace-sidebar-drawer-backdrop"]');
      if (await drawer.isDisplayed()) {
        await browser.action("pointer").move({ x: 420, y: 450 }).down().up().perform();
        await drawer.waitForDisplayed({ reverse: true });
      }
      await assertWorkbenchMenuTitle(title, `ux09-menu-${theme}-${locale}-${width}.png`);
      const layout = await browser.execute(() => {
        const heading = document.querySelector<HTMLElement>("[data-workbench-title]")!;
        const rect = heading.getBoundingClientRect();
        const describe = (node: Element | null) => {
          if (!node) return null;
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            className: node.className,
            text: node.textContent?.slice(0, 100),
            left: box.left,
            right: box.right,
            width: box.width,
            height: box.height,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            display: style.display,
            visibility: style.visibility,
          };
        };
        const header = heading.closest("header")!;
        const actions = header.querySelector(".relative.ml-auto.shrink-0");
        // macOS 没有 Windows/Linux 的 logo test ID；两种平台共用可见的浮层交互容器。
        const leading = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[class~="@container/topoverlayer"] > div > .pointer-events-auto',
          ),
        ).find((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility === "visible";
        });
        if (!leading) throw new Error("UX09 未找到可见顶部浮层操作组");
        return {
          width: innerWidth,
          left: rect.left,
          right: rect.right,
          titleWidth: rect.width,
          header: describe(header),
          actions: describe(actions),
          measuredActionsCss: getComputedStyle(header).getPropertyValue(
            "--workbench-header-actions-width",
          ),
          group: describe(heading.closest("[data-workbench-header-group]")),
          titleElement: describe(heading.querySelector("h1")),
          leadingGroup: describe(leading),
          leadingWrapper: describe(leading.parentElement),
          leadingButtons: Array.from(leading.querySelectorAll("button")).map(describe),
        };
      });
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, `ux09-${theme}-${locale}-${width}.png`),
        );
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, `ux09-layout-${width}.json`),
          JSON.stringify({ id, title, platformWindow, requestedWidth: width, ...layout }, null, 2),
        );
      }
      expect(layout.titleWidth).toBeGreaterThan(0);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(layout.width + 1);
      if (width === 430) {
        expect(layout.left).toBeGreaterThanOrEqual(layout.leadingGroup!.right);
        expect(layout.titleElement!.width).toBeGreaterThanOrEqual(48);
        expect(
          Math.min(layout.right, layout.titleElement!.right) -
            Math.max(layout.left, layout.titleElement!.left),
        ).toBeGreaterThanOrEqual(24);
        // 完整视图入口要求面板已实际展开；先在宽窗建立正式 SPFV 场景的同一前置，
        // 再缩到窄窗验证共享留白，不能把「关闭面板后首次快捷键」当成布局回归。
        await setCurrentElectronRendererContentSize(1280, 900);
        const isSidePaneExpanded = () =>
          browser.execute(() => {
            const panel = document.querySelector(
              '[data-workspace-side-frame="true"]',
            )?.parentElement;
            return Boolean(
              panel &&
              panel.getBoundingClientRect().width > 100 &&
              getComputedStyle(panel).opacity === "1",
            );
          });
        if (!(await isSidePaneExpanded())) {
          await $(
            `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
          ).click();
          await browser.waitUntil(isSidePaneExpanded, {
            timeout: 10_000,
            timeoutMsg: "UX09 完整视图前置：SidePane 未实际展开",
          });
        }
        if ((await $$("[data-side-pane-tab-id]").length) === 0) {
          const launcher = await $('[data-side-pane-open-tab-item="terminal"]');
          await launcher.waitForClickable();
          await launcher.click();
          await browser.waitUntil(async () => (await $$("[data-side-pane-tab-id]").length) > 0);
        }
        await browser.keys(fullViewShortcut);
        const fullViewTab = await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB}"]`);
        await fullViewTab.waitForDisplayed();
        await setCurrentElectronRendererContentSize(430, 900);
        const fullViewDrawer = await $('[data-testid="workspace-sidebar-drawer-backdrop"]');
        if (await fullViewDrawer.isDisplayed()) {
          await browser.action("pointer").move({ x: 420, y: 450 }).down().up().perform();
          await fullViewDrawer.waitForDisplayed({ reverse: true });
        }
        await browser.waitUntil(
          async () => {
            return browser.execute(
              (tabId, expectedPadding) => {
                const tab = document.querySelector<HTMLElement>(`[data-testid="${tabId}"]`)!;
                const tabList = tab.closest('[role="tablist"]')!;
                const rect = tab.getBoundingClientRect();
                return (
                  getComputedStyle(tabList).paddingLeft === `${expectedPadding}px` &&
                  rect.width > 0 &&
                  tab.contains(
                    document.elementFromPoint(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2,
                    ),
                  )
                );
              },
              TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB,
              compactLeadingPadding,
            );
          },
          { timeout: 5_000, timeoutMsg: "完整视图标题与窄屏浮层操作重叠" },
        );
        const fullViewLayout = await browser.execute((tabId) => {
          const tab = document.querySelector<HTMLElement>(`[data-testid="${tabId}"]`)!;
          const rect = tab.getBoundingClientRect();
          const leadingGroup = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[class~="@container/topoverlayer"] > div > .pointer-events-auto',
            ),
          ).find((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.width > 0 && box.height > 0 && getComputedStyle(node).visibility === "visible"
            );
          });
          if (!leadingGroup) throw new Error("UX09 完整视图未找到可见顶部浮层操作组");
          const leading = leadingGroup.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
            viewportWidth: innerWidth,
            leadingRight: leading.right,
            paddingLeft: getComputedStyle(tab.closest('[role="tablist"]')!).paddingLeft,
          };
        }, TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB);
        expect(await fullViewDrawer.isDisplayed()).toBe(false);
        expect(fullViewLayout.paddingLeft).toBe(`${compactLeadingPadding}px`);
        expect(fullViewLayout.left).toBeGreaterThanOrEqual(fullViewLayout.leadingRight);
        expect(fullViewLayout.right).toBeLessThanOrEqual(fullViewLayout.viewportWidth);
        expect(await fullViewTab.getAttribute("title")).toBe(title);
        if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux09-side-pane-430.png"),
          );
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux09-side-pane-layout-430.json"),
            JSON.stringify({ platformWindow, compactLeadingPadding, ...fullViewLayout }, null, 2),
          );
        }
        await browser.keys(fullViewShortcut);
        await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`).waitForDisplayed();
      }
    }
  } finally {
    await browser.electron.execute(
      (electron, windowId, old) =>
        electron.BrowserWindow.fromId(windowId)?.setMinimumSize(old[0]!, old[1]!),
      original.windowId,
      minimum,
    );
    await restoreElectronRendererContentSize(original);
    await browser.execute(() => {
      const actions = (
        window as unknown as {
          __testActions: { setLocale(value: string): void; setTheme(value: string): void };
        }
      ).__testActions;
      actions.setLocale("zh-CN");
      actions.setTheme("zai-light");
    });
  }
}

async function waitForTask(taskId: string) {
  const selectors = taskRowSelectors(taskId);
  await browser.waitUntil(
    () =>
      browser.execute(
        (values) => values.some((selector) => Boolean(document.querySelector(selector))),
        selectors,
      ),
    { timeout: 30_000, timeoutMsg: `侧栏未显示 task: ${taskId}` },
  );
}

function taskRowSelectors(taskId: string): string[] {
  return [`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`];
}

async function readTitleSnapshot(taskId: string): Promise<TitleSnapshot> {
  return browser.execute(
    (selectors, id) => {
      const row = selectors
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .find(Boolean);
      const original = row?.querySelector<HTMLElement>('[data-task-title-copy="original"]');
      const title = original?.parentElement?.parentElement as HTMLElement | null;
      const track = original?.parentElement as HTMLElement | null;
      if (!row || !original || !title || !track) throw new Error(`找不到 task title: ${id}`);
      const style = getComputedStyle(title);
      return {
        animationCount: title.getAnimations({ subtree: true }).length,
        copyCount: track.querySelectorAll("[data-task-title-copy]").length,
        duplicateAriaHidden:
          track.querySelector('[data-task-title-copy="duplicate"]')?.getAttribute("aria-hidden") ??
          null,
        maskImage: style.maskImage || style.webkitMaskImage,
        nativeTitle: title.getAttribute("title"),
        overflow: title.classList.contains("task-title-marquee"),
        rowWidth: row.getBoundingClientRect().width,
        titleWidth: title.getBoundingClientRect().width,
        trackWidth: track.getBoundingClientRect().width,
      };
    },
    taskRowSelectors(taskId),
    taskId,
  );
}

async function hoverTaskRow(taskId: string): Promise<boolean> {
  return browser.execute(
    (selectors, id) => {
      const row = selectors
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .find(Boolean);
      const original = row?.querySelector<HTMLElement>('[data-task-title-copy="original"]');
      if (!row || !original) throw new Error(`找不到 hover task: ${id}`);
      const rowRect = row.getBoundingClientRect();
      const titleRect = original.getBoundingClientRect();
      // 直接从行容器派发 mouseenter，坐标落在左侧图标区，覆盖“整行而非文字 hover”。
      row.dispatchEvent(
        new MouseEvent("mouseenter", {
          bubbles: false,
          clientX: rowRect.left + 4,
          clientY: rowRect.top + rowRect.height / 2,
        }),
      );
      return rowRect.left + 4 < titleRect.left;
    },
    taskRowSelectors(taskId),
    taskId,
  );
}

async function leaveTaskRow(taskId: string) {
  await browser.execute((selectors) => {
    selectors
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .find(Boolean)
      ?.dispatchEvent(new MouseEvent("mouseleave"));
  }, taskRowSelectors(taskId));
}

async function waitForAnimationCount(taskId: string, count: number) {
  await browser.waitUntil(async () => (await readTitleSnapshot(taskId)).animationCount === count, {
    timeout: 5_000,
    timeoutMsg: `task ${taskId} 没有启动 ${count} 个走马灯动画`,
  });
}

async function readAnimationTimeline(taskId: string) {
  return browser.execute((selectors) => {
    const row = selectors
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .find(Boolean);
    const original = row?.querySelector<HTMLElement>('[data-task-title-copy="original"]');
    if (!original) throw new Error("找不到走马灯原始标题");
    const track = original?.parentElement as HTMLElement;
    const title = track?.parentElement as HTMLElement;
    const animations = title.getAnimations({ subtree: true });
    const trackEffect = animations.find(
      (animation) => (animation.effect as KeyframeEffect).target === track,
    )?.effect as KeyframeEffect;
    const maskEffect = animations.find(
      (animation) => (animation.effect as KeyframeEffect).target === title,
    )?.effect as KeyframeEffect;
    const trackFrames = trackEffect.getKeyframes();
    const maskFrames = maskEffect.getKeyframes();
    const duration = Number(trackEffect.getTiming().duration);
    const movementOffset = Number(trackFrames[1]?.offset);
    const movementTransform = String(trackFrames[1]?.transform);
    return {
      animations: animations.map((animation) => animation.playState),
      currentTimes: animations.map((animation) => Number(animation.currentTime ?? 0)),
      distance: Math.abs(Number(movementTransform.match(/-([\d.]+)px/)?.[1] ?? 0)),
      finalTransform: String(trackFrames[2]?.transform),
      maskFrames: maskFrames.map((frame) => String(frame.maskImage ?? frame.webkitMaskImage)),
      maskOffsets: maskFrames.map((frame) => Number(frame.offset)),
      movementTransform,
      originalWidth: original.scrollWidth,
      pauseMs: duration * (1 - movementOffset),
      trackOffsets: trackFrames.map((frame) => Number(frame.offset)),
    };
  }, taskRowSelectors(taskId));
}

async function setAnimationCurrentTime(taskId: string, currentTime: number) {
  await browser.execute(
    (selectors, time) => {
      const row = selectors
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .find(Boolean);
      row?.getAnimations({ subtree: true }).forEach((animation) => {
        animation.currentTime = time;
      });
    },
    taskRowSelectors(taskId),
    currentTime,
  );
}

async function setTitleProbeWidth(taskId: string, width: number | null) {
  await browser.execute(
    (selectors, nextWidth, id) => {
      const row = selectors
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .find(Boolean);
      const original = row?.querySelector<HTMLElement>('[data-task-title-copy="original"]');
      const title = original?.parentElement?.parentElement as HTMLElement | undefined;
      if (!title) throw new Error(`找不到 resize title: ${id}`);
      title.style.flex = nextWidth === null ? "" : "0 0 auto";
      title.style.width = nextWidth === null ? "" : `${nextWidth}px`;
    },
    taskRowSelectors(taskId),
    width,
    taskId,
  );
}

async function waitForOverflow(taskId: string, expected: boolean) {
  await browser.waitUntil(async () => (await readTitleSnapshot(taskId)).overflow === expected, {
    timeout: 5_000,
    timeoutMsg: `task ${taskId} overflow 未切换为 ${expected}`,
  });
}

async function setReducedMotion(reduce: boolean) {
  await sendRendererEmulationCommand("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "prefers-reduced-motion",
        value: reduce ? "reduce" : "no-preference",
      },
    ],
  });
}

async function assertOverflowSurface(taskId: string) {
  const selectors = taskRowSelectors(taskId);
  await browser.waitUntil(
    () =>
      browser.execute(
        (values) => values.some((selector) => Boolean(document.querySelector(selector))),
        selectors,
      ),
    {
      timeout: 15_000,
      timeoutMsg: `侧栏未显示 ${taskId}`,
    },
  );
  const snapshot = await readTitleSnapshot(taskId);
  expect(snapshot.overflow).toBe(true);
  expect(snapshot.copyCount).toBe(2);
  expect(snapshot.maskImage).toContain("24px");
  expect(snapshot.nativeTitle).toBe(null);
}

async function sendRendererEmulationCommand(method: string, params: Record<string, unknown>) {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const devtools = window.webContents.debugger;
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  if (!sent) throw new Error(`没有找到可执行 ${method} 的 Electron 窗口`);
}
