import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  setCurrentElectronRendererContentSize,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

describe("TWC01/TWC02/TWC04/TWC07 双栏工作台草稿 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
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
});

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
