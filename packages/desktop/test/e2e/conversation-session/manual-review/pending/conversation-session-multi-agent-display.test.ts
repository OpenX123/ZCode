import {
  TID_CHAT_SUMMARY_RUNNING_AGENTS,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_SESSION_HEADER,
  TID_V4_SUBAGENT_SPAWN_GROUP,
  TID_V4_SUBAGENT_SPAWN_TOGGLE,
} from "@zcode/shared/test-ids";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

// MA01-MA04（docs/desktop/multi-agent-display-spec.md「验收场景」）：同一轮并行 7 个 child，
// 时间线合并为一行，胶囊显示 3 个头像与运行数，点击名称打开带头部的右侧只读详情。
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

async function readSpawnRowState(): Promise<SpawnRowState> {
  return browser.execute(
    (groupPrefix, openPrefix, capsuleTestId) => {
      const groups = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${groupPrefix}-"]`),
      );
      const group = groups[0];
      const capsule = document.querySelector<HTMLElement>(`[data-testid="${capsuleTestId}"]`);
      return {
        groups: groups.length,
        spawnCount: Number(group?.dataset.spawnCount ?? "0"),
        runningCount: Number(group?.dataset.runningCount ?? "0"),
        openActions: document.querySelectorAll(`[data-testid^="${openPrefix}-"]`).length,
        variants: Array.from(group?.querySelectorAll("svg[data-face-variant]") ?? []).map(
          (face) => face.getAttribute("data-face-variant") ?? "",
        ),
        capsuleFaces: capsule?.querySelectorAll("svg[data-subagent-avatar]").length ?? 0,
        capsuleText: capsule?.textContent ?? "",
      };
    },
    TID_V4_SUBAGENT_SPAWN_GROUP,
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

    // 展开逐个卡后，直开入口仍然每个 child 只有一个。
    const toggle = await $(`[data-testid^="${TID_V4_SUBAGENT_SPAWN_TOGGLE}-"]`);
    await toggle.click();
    expect((await readSpawnRowState()).openActions).toBe(CHILD_COUNT);

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

    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      `MA07 parent 没有在 7 个 child 完成后回到 idle（${PARENT_DONE}）`,
      120000,
    );
    await browser.waitUntil(async () => (await readSpawnRowState()).runningCount === 0, {
      timeout: 30000,
      timeoutMsg: "MA07 派发行没有收口为全部完成",
    });
    expect(await header.getAttribute("data-status")).toBe("done");
  });
});
