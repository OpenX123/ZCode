import { join } from "node:path";
import {
  TID_VIRTUAL_PROJECT_NEW_TASK,
  TID_CONVERSATION_SECTION,
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_WORKSPACE_MORE_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "./helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "./helpers/conversation-session.js";
import { sel } from "./helpers/selectors.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  getV4FocusedPaneId,
  sendV4PromptInPane,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";

describe("任务列表直接归档与撤销 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("单击归档后顶部可撤销，顶部菜单同样直接归档且通知约 5 秒消失", async function () {
    this.timeout(150000);

    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    await useProjectConversationTaskView();
    await browser.refresh();
    await startConversationTaskDraft();

    const marker = `E2E_FIRST_SEND_TASK_ARCHIVE_UNDO_${Date.now()}`;
    const paneId = await getV4FocusedPaneId();
    expect(paneId).toBeTruthy();
    await sendV4PromptInPane(paneId!, buildReadonlyToolPrompt(marker));
    await waitForV4TimelineContaining(marker);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 90000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
      "任务归档确认 E2E 前置任务没有完成",
      90000,
    );

    // 修复原因：v4 taskId 就是 pane 绑定的 sessionId；legacy ChatView root 已退出 DOM。
    const taskId = completed.sessionId ?? (await getV4PaneSnapshot()).sessionId;
    expect(taskId).toBeTruthy();

    const id = taskId as string;
    await hoverConversationTaskRow(id);
    await $(sel(testId(TID_TASK_ARCHIVE, id))).click();
    await waitForConversationTaskRowAbsent(id);
    const undo = await $("#zcode-toast-host button");
    await undo.waitForDisplayed({ timeout: 5000 });
    expect(await undo.getText()).toMatch(/撤销|Undo/);
    expect(await $("[data-archive-confirming-task-id]").isExisting()).toBe(false);
    const top = await browser.execute(() => {
      const button = document.querySelector("#zcode-toast-host button");
      const stack = button?.closest(".fixed");
      return stack ? getComputedStyle(stack).top : null;
    });
    expect(top).toBe("64px");
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "archive-undo-toast.png"),
      );
    }
    await undo.click();
    await hoverConversationTaskRow(id);

    // 归档已退出详情；显式选择恢复的任务再从 Header 操作，撤销本身不负责导航。
    await $(`${sel(TID_CONVERSATION_SECTION)} ${sel(testId(TID_TASK_ITEM, id))}`).click();
    await waitForV4Pane((snapshot) => snapshot.sessionId === id, "撤销后未能打开原会话");
    await $(sel(TID_WORKSPACE_MORE_BUTTON)).click();
    const archiveMenuItem = (await $('[role="menuitem"]*=归档').isExisting())
      ? await $('[role="menuitem"]*=归档')
      : await $('[role="menuitem"]*=Archive');
    await archiveMenuItem.click();
    await waitForConversationTaskRowAbsent(id);
    expect(await $('[role="alertdialog"]').isExisting()).toBe(false);
    const started = Date.now();
    await $("#zcode-toast-host button").waitForDisplayed({ timeout: 2000 });
    await browser.waitUntil(async () => !(await $("#zcode-toast-host button").isExisting()), {
      timeout: 7500,
      interval: 100,
      timeoutMsg: "归档撤销通知没有在约 5 秒后消失",
    });
    expect(Date.now() - started).toBeGreaterThan(3500);
    await browser.refresh();
    await waitForConversationTaskRowAbsent(id);
  });
});

async function useProjectConversationTaskView() {
  await browser.execute(() => {
    localStorage.setItem(
      "zcode-sidebar-task-preferences",
      JSON.stringify({
        organizeBy: "project",
        sortBy: "updated",
      }),
    );
    localStorage.setItem(
      "zcode-sidebar-purpose-section-preferences",
      JSON.stringify({
        projectsExpanded: true,
        conversationsExpanded: true,
        sectionOrder: ["projects", "conversations"],
      }),
    );
  });
}

async function startConversationTaskDraft() {
  // Bug 根因：refresh 后 sidebar 的 task section 会异步水合，原先同步读取 DOM
  // 偶发拿不到已经按产品语义应出现的“新建任务”按钮，尚未覆盖后续归档交互。
  await browser.waitUntil(
    async () =>
      browser.execute((testIdValue) => {
        const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testIdValue}"]`);
        return Boolean(button && !button.disabled);
      }, TID_VIRTUAL_PROJECT_NEW_TASK),
    {
      timeout: 15000,
      timeoutMsg: "项目任务区水合后没有出现可用的“新建任务”按钮",
    },
  );

  const clicked = await browser.execute((testIdValue) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="${testIdValue}"]`);
    button?.click();
    return Boolean(button);
  }, TID_VIRTUAL_PROJECT_NEW_TASK);
  expect(clicked).toBe(true);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft",
    "点击“任务”分区新建按钮后没有进入 conversation 草稿",
  );
}

async function hoverConversationTaskRow(taskId: string) {
  const row = await $(`${sel(TID_CONVERSATION_SECTION)} ${sel(testId(TID_TASK_ITEM, taskId))}`);
  await row.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: `项目视图的“任务”分区没有显示目标 conversation task: ${taskId}`,
  });
  await row.moveTo();
}

async function waitForConversationTaskRowAbsent(taskId: string) {
  const row = await $(`${sel(TID_CONVERSATION_SECTION)} ${sel(testId(TID_TASK_ITEM, taskId))}`);
  await row.waitForExist({
    reverse: true,
    timeout: 15000,
    timeoutMsg: `直接归档后 task 仍留在项目视图的“任务”分区: ${taskId}`,
  });
}
