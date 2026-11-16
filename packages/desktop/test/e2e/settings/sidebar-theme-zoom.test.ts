import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Key } from "webdriverio";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByWebDriver,
} from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

const themeShortcut = '[data-testid="sidebar-theme-shortcut"]';
const zoomIn = '[data-testid="settings-desktop-zoom-in"]';
const zoomOut = '[data-testid="settings-desktop-zoom-out"]';
const zoomReset = '[data-testid="settings-desktop-zoom-reset"]';
const artifactDir = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  "sidebar-theme-zoom",
);

describe("UX11 侧栏主题与窗口缩放", () => {
  let originalThemeSource: "system" | "light" | "dark" = "system";
  let originalWindowSize: [number, number] | null = null;

  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    originalThemeSource = await browser.electron.execute(
      (electron) => electron.nativeTheme.themeSource,
    );
    originalWindowSize = await browser.electron.execute(
      (electron) =>
        electron.BrowserWindow.getAllWindows()[0]!.getSize() as [
          number,
          number,
        ],
    );
  });

  after(async () => {
    await browser.electron.execute(
      (electron, source, size) => {
        electron.nativeTheme.themeSource = source;
        if (size)
          electron.BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]);
      },
      originalThemeSource,
      originalWindowSize,
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("UX11-01 深浅主题与真实 Tab、Enter、Space 交互", async function () {
    this.timeout(90_000);
    await openAppearance();
    await selectTheme("深色");
    await clickTestIdByWebDriver(TID_SETTINGS_BACK_BUTTON);
    const shortcut = await $(themeShortcut);
    await shortcut.waitForDisplayed();
    expect(await shortcut.getAttribute("aria-label")).toBe("切换到浅色主题");
    expect(await shortcut.getAttribute("title")).toBe("切换到浅色主题");
    expect(await shortcut.$("svg.lucide-sun").isExisting()).toBe(true);

    await shortcut.click();
    await waitForTheme("zai-light");
    expect(await shortcut.$("svg.lucide-moon").isExisting()).toBe(true);
    await saveScreenshot("footer-light-zh.png");

    await browser
      .action("key")
      .down(Key.Shift)
      .down(Key.Tab)
      .up(Key.Tab)
      .up(Key.Shift)
      .perform();
    expect(
      await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isFocused(),
    ).toBe(true);
    await browser.keys(Key.Tab);
    expect(await shortcut.isFocused()).toBe(true);
    await browser.keys(Key.Enter);
    await waitForTheme("zai-dark");
    await browser.keys(Key.Space);
    await waitForTheme("zai-light");
  });

  it("UX11-02 System 解析变化与英文设置入口", async function () {
    this.timeout(90_000);
    await openAppearance();
    await selectTheme("系统");
    await clickTestIdByWebDriver(TID_SETTINGS_BACK_BUTTON);
    expect(
      await browser.execute(() => localStorage.getItem("zcode-theme")),
    ).toBe("system");

    await browser.electron.execute((electron) => {
      electron.nativeTheme.themeSource = "dark";
    });
    await browser.waitUntil(
      async () =>
        (await $(themeShortcut).getAttribute("aria-label")) ===
        "切换到浅色主题",
    );
    await browser.electron.execute((electron) => {
      electron.nativeTheme.themeSource = "light";
    });
    await browser.waitUntil(
      async () =>
        (await $(themeShortcut).getAttribute("aria-label")) ===
        "切换到深色主题",
    );
    expect(
      await browser.execute(() => localStorage.getItem("zcode-theme")),
    ).toBe("system");
    await $(themeShortcut).click();
    await waitForTheme("zai-dark");

    await openGeneral();
    await clickTestIdByWebDriver(TID_SETTINGS_LOCALE_SELECT_TRIGGER);
    await clickTestIdByWebDriver(
      testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "en-US"),
    );
    await clickTestIdByWebDriver(TID_SETTINGS_BACK_BUTTON);
    await browser.waitUntil(
      async () =>
        (await $(themeShortcut).getAttribute("aria-label")) ===
        "Switch to light theme",
    );
    await saveScreenshot("footer-dark-en.png");
    await $(themeShortcut).click();
    await waitForTheme("zai-light");
    await browser.electron.execute((electron) => {
      electron.nativeTheme.themeSource = "system";
    });
  });

  it("UX11-03 设置页真实窗口缩放与窄窗导航", async function () {
    this.timeout(90_000);
    await openAppearance();
    await $(zoomIn).waitForDisplayed();
    const uiFontBefore = await browser.execute(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--ui-font-size",
      ),
    );
    const factorBefore = await readWindowZoomFactor();
    await $(zoomIn).click();
    await browser.waitUntil(
      async () => (await readWindowZoomFactor()) > factorBefore,
    );
    const factorAfterZoomIn = await readWindowZoomFactor();
    expect(
      await browser.execute(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--ui-font-size",
        ),
      ),
    ).toBe(uiFontBefore);
    expect(await $(zoomReset).isEnabled()).toBe(true);
    await $(zoomReset).click();
    await browser.waitUntil(
      async () => Math.abs((await readWindowZoomFactor()) - 1) < 0.01,
    );
    expect(await $(zoomReset).isEnabled()).toBe(false);
    expect(await $(zoomOut).isEnabled()).toBe(true);
    await $(zoomOut).click();
    await browser.waitUntil(async () => (await readWindowZoomFactor()) < 1);
    const factorAfterZoomOut = await readWindowZoomFactor();
    expect(await $(zoomReset).isEnabled()).toBe(true);
    await $(zoomReset).click();
    await browser.waitUntil(
      async () => Math.abs((await readWindowZoomFactor()) - 1) < 0.01,
    );
    const factorAfterReset = await readWindowZoomFactor();
    const uiFontAfter = await browser.execute(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--ui-font-size",
      ),
    );

    await browser.electron.execute((electron) => {
      electron.BrowserWindow.getAllWindows()[0]?.setSize(430, 760);
    });
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerWidth)) < 760,
    );
    await clickTestIdByWebDriver(testId(TID_SETTINGS_SECTION_NAV, "general"));
    await clickTestIdByWebDriver(
      testId(TID_SETTINGS_SECTION_NAV, "appearance"),
    );
    expect(await $(zoomIn).isDisplayed()).toBe(true);
    const layout = await browser.execute(() => {
      const page = document.querySelector<HTMLElement>(
        '[data-testid="settings-page"]',
      );
      const control = document.querySelector<HTMLElement>(
        '[data-testid="settings-desktop-zoom-in"]',
      );
      const rect = control?.getBoundingClientRect();
      return {
        pageScrollWidth: page?.scrollWidth ?? 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        controlRect: rect
          ? {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            }
          : null,
        controlVisible: Boolean(
          rect && rect.left >= 0 && rect.right <= window.innerWidth,
        ),
      };
    });
    const nativeWindow = await browser.electron.execute((electron) => {
      const window = electron.BrowserWindow.getAllWindows()[0]!;
      return { size: window.getSize(), contentSize: window.getContentSize() };
    });
    expect(layout.controlVisible).toBe(true);
    expect(layout.pageScrollWidth).toBeLessThanOrEqual(
      layout.viewportWidth + 1,
    );
    await saveScreenshot("settings-narrow.png");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "window-zoom-layout.json"),
      JSON.stringify(
        {
          factorBefore,
          factorAfterZoomIn,
          factorAfterZoomOut,
          factorAfterReset,
          resolvedLevels: [
            factorBefore,
            factorAfterZoomIn,
            factorAfterZoomOut,
            factorAfterReset,
          ].map((factor) => Math.round(Math.log(factor) / Math.log(1.1))),
          uiFontBefore,
          uiFontAfter,
          requestedWindowSize: [430, 760],
          nativeWindow,
          layout,
        },
        null,
        2,
      ),
      "utf8",
    );
    await clickTestIdByWebDriver(TID_SETTINGS_BACK_BUTTON);
    await $(themeShortcut).waitForDisplayed();
  });
});

async function openGeneral() {
  await clickTestIdByWebDriver(TID_TASK_SETTINGS_BUTTON);
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
  await clickTestIdByWebDriver(testId(TID_SETTINGS_SECTION_NAV, "general"));
}

async function openAppearance() {
  await clickTestIdByWebDriver(TID_TASK_SETTINGS_BUTTON);
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
  await clickTestIdByWebDriver(testId(TID_SETTINGS_SECTION_NAV, "appearance"));
}

async function selectTheme(label: string) {
  await $(
    '[role="combobox"][aria-label="界面主题"], [role="combobox"][aria-label="App theme"]',
  ).click();
  const options = await $$('[role="option"]');
  for (const option of options) {
    if ((await option.getText()).trim() === label) {
      await option.click();
      return;
    }
  }
  throw new Error(`未找到主题选项：${label}`);
}

async function waitForTheme(theme: "zai-light" | "zai-dark") {
  await browser.waitUntil(async () =>
    browser.execute((expected) => {
      const isDark = document.documentElement.classList.contains("dark");
      return (
        localStorage.getItem("zcode-theme") === expected &&
        isDark === (expected === "zai-dark")
      );
    }, theme),
  );
}

async function readWindowZoomFactor() {
  return browser.electron.execute((electron) =>
    electron.BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
  );
}

async function saveScreenshot(name: string) {
  await mkdir(artifactDir, { recursive: true });
  await browser.saveScreenshot(join(artifactDir, name));
}
