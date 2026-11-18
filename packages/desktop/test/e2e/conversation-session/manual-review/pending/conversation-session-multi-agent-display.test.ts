import {
  TID_CHAT_SUMMARY_RUNNING_AGENTS,
  TID_V4_SUBAGENT_DIRECTORY,
  TID_V4_SUBAGENT_DIRECTORY_ITEM,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_SESSION_BACK,
  TID_V4_SUBAGENT_SESSION_HEADER,
  TID_V4_SUBAGENT_WORK_CARD,
} from "@zcode/shared/test-ids";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

// MA01-MA04、MA16（docs/desktop/multi-agent-display-spec.md「验收场景」）：同一轮并行 7 个 child，
// 时间线为连续 7 行子智能体行（1.4，无工作卡外框），胶囊显示 3 个头像与运行数；点击行打开右侧唯一
// "子智能体"Tab 并进入详情，切换另一行仍是同一个 Tab，返回箭头回到目录，目录项再次进入详情。
const TIMEOUT_MS = 180000;
const CHILD_COUNT = 7;
const PARENT_MARKER = "E2E_MULTI_AGENT_DISPLAY_PARENT";
const PARENT_DONE = "E2E_MULTI_AGENT_DISPLAY_PARENT_DONE";

interface SpawnRowState {
  groups: number;
  spawnCount: number;
  runningCount: number;
  openActions: number;
  variants: string[];
  capsuleFaces: number;
  capsuleText: string;
}

interface SubagentTabState {
  directoryTabs: number;
  legacyChildTabs: number;
  activeDirectoryTab: boolean;
}

async function readSubagentTabState(): Promise<SubagentTabState> {
  return browser.execute(() => ({
    directoryTabs: document.querySelectorAll('[data-side-pane-tab-id^="subagent-directory:"]')
      .length,
    legacyChildTabs: document.querySelectorAll('[data-side-pane-tab-id^="subagent-session:"]')
      .length,
    activeDirectoryTab: Boolean(
      document.querySelector('[data-side-pane-tab-id^="subagent-directory:"][data-state="active"]'),
    ),
  }));
}

async function readRowLayout() {
  return browser.execute((groupPrefix) => {
    const group = document.querySelector<HTMLElement>(
      `[data-testid^="${groupPrefix}-"][data-member-count]`,
    );
    const style = group ? getComputedStyle(group) : null;
    return {
      tag: group?.tagName ?? "",
      rows: group?.querySelectorAll(":scope > li").length ?? 0,
      borderTopWidth: style?.borderTopWidth ?? "",
      text: group?.textContent ?? "",
    };
  }, TID_V4_SUBAGENT_WORK_CARD);
}

async function waitForHeader(childSessionId: string, message: string) {
  const header = await $(
    `[data-testid="${TID_V4_SUBAGENT_SESSION_HEADER}"][data-child-session-id="${childSessionId}"]`,
  );
  await header.waitForDisplayed({ timeout: 15000, timeoutMsg: message });
  return header;
}

async function readSpawnRowState(): Promise<SpawnRowState> {
  return browser.execute(
    (groupPrefix, openPrefix, capsuleTestId) => {
      // 工作卡根带 data-member-count；同前缀的停止 / 折叠按钮不计入。
      const groups = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${groupPrefix}-"][data-member-count]`,
        ),
      );
      const group = groups[0];
      const capsule = document.querySelector<HTMLElement>(`[data-testid="${capsuleTestId}"]`);
      return {
        groups: groups.length,
        spawnCount: Number(group?.dataset.memberCount ?? "0"),
        runningCount: group?.dataset.state === "running" ? Number(group.dataset.memberCount) : 0,
        openActions: document.querySelectorAll(`[data-testid^="${openPrefix}-"]`).length,
        variants: Array.from(group?.querySelectorAll("svg[data-face-variant]") ?? []).map(
          (face) => face.getAttribute("data-face-variant") ?? "",
        ),
        capsuleFaces: capsule?.querySelectorAll("svg[data-subagent-avatar]").length ?? 0,
        capsuleText: capsule?.textContent ?? "",
      };
    },
    TID_V4_SUBAGENT_WORK_CARD,
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    TID_CHAT_SUMMARY_RUNNING_AGENTS,
  );
}

describe("多智能体展示 manual review", () => {
  before(async function () {
    this.timeout(TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MA01-MA04: 7 个并行 child 合并为一行、胶囊头像串与右侧详情头部", async function () {
    this.timeout(TIMEOUT_MS);
    await sendV4Prompt(
      `${PARENT_MARKER}: launch exactly seven Agent calls in one parallel tool-use response, then reply ${PARENT_DONE} after all children finish.`,
    );
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && snapshot.canStop,
      "MA01 没有进入 running parent session",
      60000,
    );

    let state: SpawnRowState | null = null;
    await browser.waitUntil(
      async () => {
        state = await readSpawnRowState();
        return (
          state.groups === 1 &&
          state.spawnCount === CHILD_COUNT &&
          state.openActions === CHILD_COUNT
        );
      },
      {
        interval: 200,
        timeout: 30000,
        timeoutMsg: `MA01 没有合并为一行 7 个派发：${JSON.stringify(state)}`,
      },
    );
    const live = await readSpawnRowState();
    // fixture 第 1、4 个为 Explore（天线），其余 general-purpose（基础）。
    expect(live.variants).toEqual(["antenna", "base", "base", "antenna", "base", "base", "base"]);
    expect(live.runningCount).toBe(CHILD_COUNT);
    // 胶囊项常驻 DOM（展开态只是隐藏）：最多 3 个头像 + 运行数。
    expect(live.capsuleFaces).toBe(3);
    expect(live.capsuleText).toContain(String(CHILD_COUNT));

    // 每个 child 只有一个直开入口（子智能体行）。
    expect((await readSpawnRowState()).openActions).toBe(CHILD_COUNT);
    // 1.4：连续 7 行，没有工作卡外框、标题或主 Agent 节点；运行中行带"运行中"。
    const rowLayout = await readRowLayout();
    expect(rowLayout).toMatchObject({ tag: "UL", rows: CHILD_COUNT, borderTopWidth: "0px" });
    expect(rowLayout.text).not.toContain("Subagent 正在工作");
    expect(rowLayout.text).not.toContain("主 Agent");
    expect(rowLayout.text).toContain("运行中");
    expect(await readSubagentTabState()).toEqual({
      directoryTabs: 0,
      legacyChildTabs: 0,
      activeDirectoryTab: false,
    });

    const firstName = await $(`[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`);
    const childTestId = (await firstName.getAttribute("data-testid")) ?? "";
    const childSessionId = childTestId.slice(`${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-`.length);
    await firstName.click();
    const header = await $(
      `[data-testid="${TID_V4_SUBAGENT_SESSION_HEADER}"][data-child-session-id="${childSessionId}"]`,
    );
    await header.waitForDisplayed({ timeout: 15000, timeoutMsg: "MA04 右侧详情没有头部" });
    expect(await header.getAttribute("data-status")).toBe("running");
    expect(await header.getAttribute("data-face-variant")).toBe("antenna");
    expect(await header.getText()).toContain("E2E display child 01");
    expect(await readSubagentTabState()).toEqual({
      directoryTabs: 1,
      legacyChildTabs: 0,
      activeDirectoryTab: true,
    });

    // MA16：点另一行仍复用同一个"子智能体"Tab，只切换详情。
    const members = await $$(`[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`);
    const secondChildId = ((await members[1]!.getAttribute("data-testid")) ?? "").slice(
      `${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-`.length,
    );
    await members[1]!.click();
    await waitForHeader(secondChildId, "MA16 点第二行后详情没有切换");
    expect(await header.isExisting()).toBe(false);
    expect((await readSubagentTabState()).directoryTabs).toBe(1);

    // 返回箭头回到目录：运行中 · 7，目录项可再次进入详情。
    await $(`[data-testid="${TID_V4_SUBAGENT_SESSION_BACK}"]`).click();
    const directory = await $(`[data-testid="${TID_V4_SUBAGENT_DIRECTORY}"]`);
    await directory.waitForDisplayed({ timeout: 15000, timeoutMsg: "MA16 返回后没有显示目录" });
    await browser.waitUntil(
      async () =>
        (await directory.$$(`[data-testid^="${TID_V4_SUBAGENT_DIRECTORY_ITEM}-"]`).length) >=
        CHILD_COUNT,
      { timeout: 15000, timeoutMsg: "MA16 目录没有列出全部子智能体" },
    );
    expect(await directory.getText()).toContain(`· ${CHILD_COUNT}`);
    const thirdItem = (
      await directory.$$(`[data-testid^="${TID_V4_SUBAGENT_DIRECTORY_ITEM}-"]`)
    )[2]!;
    const thirdChildId = ((await thirdItem.getAttribute("data-testid")) ?? "").slice(
      `${TID_V4_SUBAGENT_DIRECTORY_ITEM}-`.length,
    );
    await thirdItem.click();
    await waitForHeader(thirdChildId, "MA16 目录项没有进入详情");
    expect((await readSubagentTabState()).directoryTabs).toBe(1);
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        `${process.env.ZCODE_E2E_ARTIFACT_DIR}/ma16-single-subagent-tab.png`,
      );
    }

    // 回到第一个 child 继续观察收口。
    await firstName.click();
    const firstHeader = await waitForHeader(childSessionId, "MA16 回到第一行详情失败");

    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      `MA07 parent 没有在 7 个 child 完成后回到 idle（${PARENT_DONE}）`,
      120000,
    );
    await browser.waitUntil(async () => (await readSpawnRowState()).runningCount === 0, {
      timeout: 30000,
      timeoutMsg: "MA07 工作卡没有收口为全部完成",
    });
    await browser.waitUntil(
      async () => (await firstHeader.getAttribute("data-status")) === "done",
      { timeout: 30000, timeoutMsg: "MA07 详情头部没有变为已完成" },
    );
    // 全部成功结束的行组回到「已工作」折叠内（spec「对话行内子智能体行 · 折叠」），展开历史回看。
    await $('[data-testid^="chat-assistant-history-trigger-"]').click();
    await browser.waitUntil(async () => (await readRowLayout()).rows === CHILD_COUNT, {
      timeout: 15000,
      timeoutMsg: "MA07 展开历史后没有看到 7 行子智能体行",
    });
    const endedText = (await readRowLayout()).text;
    expect(endedText).toContain("已完成");
    expect(endedText).not.toContain("运行中");
  });
});
