import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import {
  TID_PREVIEW_PANE,
  TID_SIDE_PANE_TOGGLE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SPLIT_DIVIDER,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4FocusedPaneId,
  getV4PaneSnapshot,
} from "../../../helpers/v4-conversation.js";

describe("TWC01/TWC02/TWC04/TWC07 双栏工作台草稿 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(join(DEFAULT_WORKSPACE, "ux10-context.md"), { force: true });
  });

  it("右上分栏、独立标题与输入、菜单移动交换、窄屏切栏、刷新恢复以及关闭分栏保留草稿", async function () {
    this.timeout(150000);
    await setCurrentElectronRendererContentSize(1600, 800);
    await prepareV4ConversationE2E({ skipProvider: true });
    const initial = await readGroups();
    expect(initial).toHaveLength(1);
    expect(await $$('[data-testid^="workbench-tabs-"]')).toHaveLength(0);
    const leftId = initial[0]!.tabId;
    await writeDraft(leftId, "E2E_TWC_LEFT_DRAFT");
    await selectLayoutAction("workbench-split-right");
    await browser.waitUntil(async () => (await readGroups()).length === 2, {
      timeout: 15000,
      timeoutMsg: "向右分屏未产生独立草稿",
    });
    const split = await readGroups();
    const rightId = split[1]!.tabId;
    expect(rightId).not.toBe(leftId);
    await writeDraft(rightId, "E2E_TWC_RIGHT_DRAFT");
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");
    expect(await readDraft(rightId)).toBe("E2E_TWC_RIGHT_DRAFT");
    for (const id of [leftId, rightId]) {
      const header = await $(`[data-testid="workbench-pane-header-${id}"]`);
      await header.waitForDisplayed({ timeout: 10000 });
      expect(await header.$("[data-workbench-project]").getText()).not.toBe("");
      expect(await header.$("[data-workbench-title]").getText()).not.toBe("");
      await $(`[data-testid="workbench-close-pane-${id}"]`).waitForDisplayed({ timeout: 10000 });
    }
    expect(
      await browser.execute(() =>
        [...document.querySelectorAll<HTMLElement>("[data-pane-id]")].some((pane) =>
          pane.classList.contains("ring-1"),
        ),
      ),
    ).toBe(false);

    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "two-column-workbench.png"),
      );
    }

    await selectLayoutAction("workbench-swap-groups");
    await browser.waitUntil(async () => (await readGroups())[0]?.tabId === rightId, {
      timeout: 10000,
      timeoutMsg: "交换左右后 Tab 身份未随栏移动",
    });
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");
    expect(await readDraft(rightId)).toBe("E2E_TWC_RIGHT_DRAFT");

    await setCurrentElectronRendererContentSize(700, 800);
    const switcher = await $(`[data-testid="workbench-switch-group-${split[0]!.groupId}"]`);
    await switcher.waitForDisplayed({ timeout: 10000 });
    await switcher.click();
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");
    expect(await readDraft(rightId)).toBe("E2E_TWC_RIGHT_DRAFT");
    await setCurrentElectronRendererContentSize(1600, 800);

    // 等待真实草稿持久化，而非用固定延时掩盖保存与刷新之间的时序。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const values = Object.values(window.localStorage);
          return (
            values.some((value) => value.includes("E2E_TWC_LEFT_DRAFT")) &&
            values.some((value) => value.includes("E2E_TWC_RIGHT_DRAFT"))
          );
        }),
      { timeout: 15000, timeoutMsg: "两个 Tab 的草稿未独立持久化" },
    );
    await browser.refresh();
    await browser.waitUntil(async () => (await readGroups()).length === 2, {
      timeout: 30000,
      timeoutMsg: "刷新后双栏布局未恢复",
    });
    await browser.waitUntil(
      async () =>
        (await readDraft(leftId)) === "E2E_TWC_LEFT_DRAFT" &&
        (await readDraft(rightId)) === "E2E_TWC_RIGHT_DRAFT",
      {
        timeout: 15000,
        timeoutMsg: "刷新后双栏草稿未恢复",
      },
    );
    // × 关闭的是整栏，将视图合入另一栏，不能误关草稿或切走目标当前会话。
    await $(`[data-testid="workbench-close-pane-${rightId}"]`).click();
    await browser.waitUntil(
      async () => {
        const groups = await readGroups();
        return groups.length === 1 && groups[0]?.tabId === leftId;
      },
      { timeout: 10000, timeoutMsg: "关闭分栏没有保留另一栏的当前视图" },
    );
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");
    expect(await readDraft(rightId)).toBe("E2E_TWC_RIGHT_DRAFT");
    expect(await $$("[data-pane-id]")).toHaveLength(2);
    expect(await $$('[data-testid^="workbench-close-pane-"]')).toHaveLength(0);
    await selectLayoutAction(`workbench-activate-tab-${rightId}`);
    await browser.waitUntil(async () => (await readGroups())[0]?.tabId === rightId, {
      timeout: 10000,
      timeoutMsg: "合并的后台草稿无法通过布局菜单找回",
    });
    const restoredInput = await $(
      `[data-pane-id="${rightId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`,
    );
    await restoredInput.waitForDisplayed({ timeout: 10000 });
    expect(await readDraft(rightId)).toBe("E2E_TWC_RIGHT_DRAFT");
    await selectLayoutAction(`workbench-activate-tab-${leftId}`);
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");
    await selectLayoutAction(`workbench-activate-tab-${rightId}`);
    await selectLayoutAction("workbench-close-view");
    await browser.waitUntil(async () => (await readGroups()).length === 1, {
      timeout: 10000,
      timeoutMsg: "关闭栏内最后一个 Tab 后未合并",
    });
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");

    // 通过布局菜单移动草稿，顶部会话栏移除后仍可重新激活后台草稿。
    await selectLayoutAction("workbench-split-right");
    await browser.waitUntil(async () => (await readGroups()).length === 2, {
      timeout: 10000,
      timeoutMsg: "第二次分栏未完成",
    });
    const movedGroups = await readGroups();
    const newRightId = movedGroups[1]!.tabId;
    await writeDraft(newRightId, "E2E_TWC_MOVED_DRAFT");
    await selectLayoutAction("workbench-move-to-other-group");
    await browser.waitUntil(async () => (await readGroups()).length === 1, {
      timeout: 10000,
      timeoutMsg: "跨栏移动最后一个 Tab 后未合并空栏",
    });
    expect(await $$("[data-pane-id]")).toHaveLength(2);
    expect(await readDraft(newRightId)).toBe("E2E_TWC_MOVED_DRAFT");
    await selectLayoutAction(`workbench-activate-tab-${leftId}`);
    expect(await readDraft(leftId)).toBe("E2E_TWC_LEFT_DRAFT");
  });

  it("UX10: 真实会话菜单原子右移、实际759/760/761边界与文件预览上下文保留", async function () {
    this.timeout(240000);
    const originalWindow = await setCurrentElectronRendererContentSize(1600, 900);
    const originalZoom = await browser.electron.execute(
      (electron, id) => electron.BrowserWindow.fromId(id)!.webContents.getZoomFactor(),
      originalWindow.windowId,
    );
    try {
      await prepareV4ConversationE2E();
      await writeFile(
        join(DEFAULT_WORKSPACE, "ux10-context.md"),
        "# UX10_CONTEXT_HEADER\n\n" +
          Array.from({ length: 180 }, (_, i) => `UX10 context line ${i + 1}\n`).join("\n"),
      );
      await sendV4Prompt(
        "E2E_UX10_WORKBENCH: reply UX10_WORKBENCH_READY and link ux10-context.md.",
      );
      await waitForV4AssistantMessageContaining("UX10_WORKBENCH_READY");
      const sessionTab = (await getV4FocusedPaneId())!;
      const sessionId = (await getV4PaneSnapshot(sessionTab)).sessionId!;
      expect(sessionId).not.toBe("draft");
      const before = await readWorkbenchSnapshot();
      await selectLayoutAction(`workbench-activate-tab-${sessionTab}`);
      await browser.waitUntil(async () => (await readGroups())[1]?.tabId === sessionTab);
      const moved = await readWorkbenchSnapshot();
      expect(moved.tabs[sessionTab]).toEqual(before.tabs[sessionTab]);
      expect(Object.values(moved.tabs).filter((tab) => tab.sessionId === sessionId)).toHaveLength(
        1,
      );
      const draftTab = moved.groups[0]!.activeTabId;
      expect(moved.tabs[draftTab]).toMatchObject({ sessionId: null, draftId: draftTab });
      await writeDraft(draftTab, "UX10_UNSENT_LEFT_DRAFT");
      await selectLayoutAction(`workbench-activate-tab-${sessionTab}`);
      expect((await readWorkbenchSnapshot()).groups).toEqual(moved.groups);

      // 操作真实分隔条，比例由既有 store 持有；所有阈值断言测内容容器而非请求窗口宽。
      const divider = await $(`[data-testid="${TID_V4_SPLIT_DIVIDER}"]`);
      await divider.waitForDisplayed();
      {
        const box = await divider.getLocation();
        await browser
          .action("pointer")
          .move({ x: Math.round(box.x), y: Math.round(box.y + 80) })
          .down()
          .move({ x: Math.round(box.x + 40), y: Math.round(box.y + 80), duration: 200 })
          .up()
          .perform();
      }
      const savedRatio = (await readWorkbenchSnapshot()).ratio;
      const geometry = [];
      // 原生125%缩放可能没有整数CSS容器落点；先记录实际两侧，再用真实Electron缩放统一有效DPR。
      for (const requested of [1032, 1034, 1036, 1038]) {
        await setCurrentElectronRendererContentSize(requested, 900);
        const measured = await readConversationGeometry();
        geometry.push({ phase: "native-default", requested, ...measured });
        await browser.waitUntil(
          async () => (await visibleGroupCount()) === (measured.containerWidth < 760 ? 1 : 2),
        );
      }
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-default-geometry.json"),
          JSON.stringify(geometry, null, 2),
        );
      }
      const defaultGeometry = await readConversationGeometry();
      if (defaultGeometry.dpr !== 1) {
        await browser.electron.execute(
          (electron, id, factor) =>
            electron.BrowserWindow.fromId(id)!.webContents.setZoomFactor(factor),
          originalWindow.windowId,
          originalZoom / defaultGeometry.dpr,
        );
        await browser.waitUntil(async () => (await browser.execute(() => devicePixelRatio)) === 1);
      }
      for (const width of [759, 760, 761]) {
        await browser.execute((dark) => {
          const actions = (
            window as unknown as {
              __testActions: { setTheme(value: string): void; setLocale(value: string): void };
            }
          ).__testActions;
          actions.setTheme(dark ? "zai-dark" : "zai-light");
          actions.setLocale(dark ? "en-US" : "zh-CN");
        }, width === 760);
        geometry.push(await setMeasuredConversationWidth(width));
        await browser.waitUntil(async () => (await visibleGroupCount()) === (width < 760 ? 1 : 2), {
          timeoutMsg: `UX10 实测${width}px时可见栏数错误`,
        });
        expect((await readWorkbenchSnapshot()).ratio).toBe(savedRatio);
        expect(await readDraft(draftTab)).toBe("UX10_UNSENT_LEFT_DRAFT");
        if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, `ux10-container-${width}.png`),
          );
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-boundary-geometry.json"),
            JSON.stringify(geometry, null, 2),
          );
        }
      }
      geometry.push(await setMeasuredConversationWidth(1000));
      await browser.waitUntil(async () => (await visibleGroupCount()) === 2);
      const fileLink = await $(`[data-pane-id="${sessionTab}"] button[title$="ux10-context.md"]`);
      await fileLink.waitForDisplayed();
      await fileLink.click();
      const preview = await $(`[data-testid="${TID_PREVIEW_PANE}"]`);
      await preview.waitForDisplayed();
      await browser.waitUntil(async () =>
        (await preview.getText()).includes("UX10_CONTEXT_HEADER"),
      );
      await preview.$('[data-markdown-preview="true"]').waitForDisplayed();
      await browser.waitUntil(async () => (await visibleGroupCount()) === 1, {
        timeoutMsg: "UX10 文件预览展开未使实际会话容器跨至760以下",
      });
      const fileTab = await $('[data-side-pane-tab-id^="code-viewer:"]');
      const fileTabId = await fileTab.getAttribute("data-side-pane-tab-id");
      const previewRect = await preview.getLocation();
      await browser
        .action("wheel")
        .scroll({
          x: Math.round(previewRect.x + 60),
          y: Math.round(previewRect.y + 120),
          deltaY: 650,
          deltaX: 0,
          duration: 300,
        })
        .perform();
      await browser.waitUntil(async () => (await readPreviewScroll()) > 100);
      const savedScroll = await readPreviewScroll();
      geometry.push(await readConversationGeometry());
      await selectLayoutAction(`workbench-activate-tab-${draftTab}`);
      expect(await readDraft(draftTab)).toBe("UX10_UNSENT_LEFT_DRAFT");
      await selectLayoutAction(`workbench-activate-tab-${sessionTab}`);
      await fileTab.waitForDisplayed();
      expect(await fileTab.getAttribute("data-side-pane-tab-id")).toBe(fileTabId);
      await preview.$('[data-markdown-preview="true"]').waitForDisplayed();
      await browser.waitUntil(async () => Math.abs((await readPreviewScroll()) - savedScroll) < 2, {
        timeoutMsg: "UX10 焦点往返后预览滚动未保留",
      });
      // 同一真实菜单再次点击右栏会话只激活；正文、草稿、预览身份均不变。
      await selectLayoutAction(`workbench-activate-tab-${sessionTab}`);
      expect((await readWorkbenchSnapshot()).groups).toEqual(moved.groups);
      expect(await readPreviewScroll()).toBe(savedScroll);
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-preview-context.png"),
        );
      }
      const toggles = await $$(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
      for (const toggle of toggles)
        if (await toggle.isDisplayed()) {
          await toggle.click();
          break;
        }
      await browser.waitUntil(async () => (await visibleGroupCount()) === 2);
      expect((await readWorkbenchSnapshot()).ratio).toBe(savedRatio);
      await selectLayoutAction("workbench-merge-groups");
      await selectLayoutAction(`workbench-activate-tab-${draftTab}`);
      expect(await readDraft(draftTab)).toBe("UX10_UNSENT_LEFT_DRAFT");
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-geometry.json"),
          JSON.stringify(
            { geometry, savedRatio, savedScroll, sessionTab, sessionId, fileTabId },
            null,
            2,
          ),
        );
      }
    } finally {
      await browser.electron.execute(
        (electron, id, factor) =>
          electron.BrowserWindow.fromId(id)!.webContents.setZoomFactor(factor),
        originalWindow.windowId,
        originalZoom,
      );
      await restoreElectronRendererContentSize(originalWindow);
      const restoredZoom = await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)!.webContents.getZoomFactor(),
        originalWindow.windowId,
      );
      expect(restoredZoom).toBe(originalZoom);
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "ux10-zoom-restored.json"),
          JSON.stringify(
            { originalZoom, restoredZoom, dpr: await browser.execute(() => devicePixelRatio) },
            null,
            2,
          ),
        );
      }
    }
  });
});

async function readWorkbenchSnapshot() {
  return browser.execute(
    () =>
      JSON.parse(localStorage.getItem("zcode-conversation-workbench:v1")!) as {
        groups: Array<{ id: string; tabIds: string[]; activeTabId: string }>;
        tabs: Record<string, { id: string; sessionId: string | null; draftId?: string }>;
        ratio: number;
      },
  );
}

async function visibleGroupCount() {
  return browser.execute(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-pane-id][data-group-active="true"]'),
      ).filter((node) => node.getBoundingClientRect().width > 0 && node.getClientRects().length > 0)
        .length,
  );
}

async function readConversationGeometry() {
  const measured = await browser.execute(
    () =>
      new Promise<{
        viewport: number;
        containerWidth: number;
        rectWidth: number;
        left: number;
        right: number;
        dpr: number;
      }>((resolve) => {
        const container = document.querySelector(
          '[data-testid="conversation-workbench"]',
        )!.lastElementChild!;
        const observer = new ResizeObserver(([entry]) => {
          const rect = container.getBoundingClientRect();
          observer.disconnect();
          resolve({
            viewport: innerWidth,
            containerWidth: entry!.contentRect.width,
            rectWidth: rect.width,
            left: rect.left,
            right: rect.right,
            dpr: devicePixelRatio,
          });
        });
        observer.observe(container);
      }),
  );
  const native = await browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getFocusedWindow()!;
    return { contentSize: win.getContentSize(), zoom: win.webContents.getZoomFactor() };
  });
  return { ...measured, ...native };
}

async function setMeasuredConversationWidth(width: number) {
  const samples = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const measured = await readConversationGeometry();
    samples.push(measured);
    if (measured.containerWidth === width) return { target: width, ...measured };
    if (Math.abs(measured.containerWidth - width) <= 16) {
      // 原生窗口像素可能跨过整数CSS落点；用产品真实Sidebar分隔条细调，不改DOM样式。
      const handle = await $('[role="separator"][aria-controls="sidebar"]');
      await handle.waitForDisplayed();
      const current = Number(await handle.getAttribute("aria-valuenow"));
      const minimum = Number(await handle.getAttribute("aria-valuemin"));
      if (current + measured.containerWidth - width < minimum) {
        // 产品侧栏有真实最小宽度；先增大原生窗口，随后向右拖侧栏，不能对下限重复空操作。
        await setCurrentElectronRendererContentSize(
          measured.contentSize[0]! +
            Math.ceil((width - measured.containerWidth + 8) * measured.zoom),
          900,
        );
        continue;
      }
      const box = await handle.getLocation();
      const x = Math.round(box.x + 2);
      const y = Math.round(box.y + 100);
      await browser
        .action("pointer")
        .move({ x, y })
        .down()
        .move({ x: x + Math.round(measured.containerWidth - width), y, duration: 200 })
        .up()
        .perform();
    } else {
      await setCurrentElectronRendererContentSize(
        Math.round(measured.contentSize[0]! + (width - measured.containerWidth) * measured.zoom),
        900,
      );
    }
  }
  throw new Error(`UX10 原生窗口未能精确命中会话容器${width}px：${JSON.stringify(samples)}`);
}

async function readPreviewScroll() {
  return browser.execute(
    (id) =>
      Math.max(
        0,
        ...Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"] *`)).map(
          (node) => node.scrollTop,
        ),
      ),
    TID_PREVIEW_PANE,
  );
}

async function readGroups() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id][data-group-active="true"]'))
      .sort((a, b) => Number(a.dataset.groupIndex) - Number(b.dataset.groupIndex))
      .map((pane) => ({ groupId: pane.dataset.groupId!, tabId: pane.dataset.paneId! })),
  );
}

async function selectLayoutAction(testId: string) {
  await $('[data-testid="workbench-layout-menu"]').click();
  const action = await $(`[data-testid="${testId}"]`);
  await action.waitForDisplayed({ timeout: 10000 });
  await action.click();
  // 菜单关闭与视图更新可分帧提交；等到触发器已关闭再执行下一步，避免下一次点击反而收起菜单。
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="workbench-layout-menu"]').getAttribute("data-state")) !== "open",
    { timeout: 10000, timeoutMsg: "布局动作完成后菜单未收起" },
  );
}

async function readDraft(tabId: string) {
  return browser.execute(
    (id, inputId) => {
      const pane = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
      const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputId}"]`);
      return input?.textContent?.replace(/\u00a0/g, " ") ?? null;
    },
    tabId,
    TID_V4_COMPOSER_INPUT,
  );
}

async function writeDraft(tabId: string, text: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id, inputId, value) => {
          const input = document
            .querySelector<HTMLElement>(`[data-pane-id="${id}"]`)
            ?.querySelector<HTMLElement>(`[data-testid="${inputId}"]`);
          const bridge = (
            input as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: {
                    focus(): void;
                    setText(value: string): void;
                    getText(): string;
                  };
                })
              | null
          )?.__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.focus();
          bridge.setText(value);
          return bridge.getText() === value;
        },
        tabId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    {
      timeout: 15000,
      timeoutMsg: `Tab ${tabId} 的编辑器未就绪`,
    },
  );
}
