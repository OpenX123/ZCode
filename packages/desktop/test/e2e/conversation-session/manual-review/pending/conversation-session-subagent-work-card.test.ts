import {
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_SESSION_HEADER,
  TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT,
  TID_V4_SUBAGENT_WORK_CARD,
  TID_V4_SUBAGENT_WORK_CARD_STOP,
  TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
} from "@zcode/shared/test-ids";
import { join } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
} from "../../../helpers/v4-conversation.js";
import { ensureToolCrossProductFullAccessMode } from "../../../helpers/conversation-session-tool-cross-product.js";

// SAT31–SAT33（docs/conversation-session-case-catalog.md；规范见 docs/desktop/multi-agent-display-spec.md
// 「对话行内 Subagent 工作卡」）：内置引擎（native）派发一个可停的后台子智能体 →
// 时间线出现工作卡 → 点击成员行在右侧打开只读子会话并实时增长 → 卡片"停止"经父会话
// cancelBackgroundWork 停止。case-local replay fixture：
// test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-work-card.json。
// 修复原因：旧版用 conversation-session.ts 的 prepareConversationE2E，它只认固定的
// v4-session-pane-workspace-main；双栏工作台（e7adc8ca）后每个 Tab 的 pane id 都是 UUID，
// 草稿就绪判断永远为 false。这里与同目录 multi-agent-display 一样改用按焦点 pane 解析的 v4 helper。
// 回放 fixture 不能回显随机 runId，因此 marker 固定；每个 case 前 clearAppData 已隔离历史。
const TIMEOUT_MS = 240000;
const PARENT_MARKER = "E2E_SUBAGENT_WORK_CARD_PARENT";
const LAUNCHED = "E2E_SUBAGENT_WORK_CARD_LAUNCHED";

interface WorkCardState {
  cards: number;
  state: string;
  memberCount: number;
  openActions: number;
  stopAll: number;
  memberStops: number;
  text: string;
}

async function readWorkCardState(): Promise<WorkCardState> {
  return browser.execute(
    (cardPrefix, openPrefix, stopAllPrefix, stopPrefix) => {
      // 卡片根带 data-member-count；同前缀的停止 / 折叠按钮不计入卡片数。
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${cardPrefix}-"][data-member-count]`,
        ),
      );
      const card = cards[0];
      return {
        cards: cards.length,
        state: card?.dataset.state ?? "",
        memberCount: Number(card?.dataset.memberCount ?? "0"),
        openActions: card?.querySelectorAll(`[data-testid^="${openPrefix}-"]`).length ?? 0,
        stopAll: card?.querySelectorAll(`[data-testid^="${stopAllPrefix}-"]`).length ?? 0,
        memberStops: card?.querySelectorAll(`[data-testid^="${stopPrefix}-"]`).length ?? 0,
        text: card?.textContent ?? "",
      };
    },
    TID_V4_SUBAGENT_WORK_CARD,
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
    TID_V4_SUBAGENT_WORK_CARD_STOP,
  );
}

async function readChildRowCount(childSessionId: string): Promise<number> {
  return browser.execute((sessionId) => {
    const pane = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    return Number(
      pane?.querySelector<HTMLElement>('[data-testid="v4-timeline"]')?.dataset.rowCount ?? 0,
    );
  }, childSessionId);
}

describe("Subagent 工作卡 manual review", () => {
  before(async function () {
    this.timeout(TIMEOUT_MS);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
  });

  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir) {
      await browser.saveScreenshot(join(artifactDir, "subagent-work-card-failure.png"));
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT31-SAT33: 工作卡 → 右侧只读子会话实时更新 → 停止", async function () {
    this.timeout(TIMEOUT_MS);
    await sendV4Prompt(
      [
        `${PARENT_MARKER}: launch exactly one Agent with run_in_background true and subagent_type "Explore".`,
        `The child must run Bash command "sleep 30" and then Bash command "sleep 60", one call at a time, then reply with exactly E2E_SUBAGENT_WORK_CARD_CHILD_DONE.`,
        `After the background launch tool returns, reply with exactly ${LAUNCHED} without waiting.`,
      ].join(" "),
    );
    await waitForV4ComposerText("", "工作卡首发后输入框没有清空");
    await waitForV4AssistantMessageContaining(LAUNCHED);

    // SAT31：单个带子会话的派发也渲染为工作卡；后台子智能体可停，"停止全部"出现。
    let state: WorkCardState | null = null;
    try {
      await browser.waitUntil(
        async () => {
          state = await readWorkCardState();
          return (
            state.cards === 1 &&
            state.state === "running" &&
            state.memberCount === 1 &&
            state.openActions === 1 &&
            state.stopAll === 1 &&
            state.memberStops === 1
          );
        },
        { interval: 200, timeout: 90000 },
      );
    } catch (error) {
      // 修复原因：timeoutMsg 在 waitUntil 调用时就已求值，旧写法永远报告 null；超时后用最新状态报错。
      throw new Error(`SAT31 没有出现运行中的工作卡：${JSON.stringify(state)}`, { cause: error });
    }
    expect((await readWorkCardState()).text).toContain("Explore");

    // SAT32：点击成员行打开右侧只读子会话；不自动打开。
    const member = await $(`[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`);
    const childSessionId = ((await member.getAttribute("data-testid")) ?? "").slice(
      `${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-`.length,
    );
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-side-pane-tab-id^="subagent-session:"]').length,
      ),
    ).toBe(0);
    await member.click();
    const header = await $(
      `[data-testid="${TID_V4_SUBAGENT_SESSION_HEADER}"][data-child-session-id="${childSessionId}"]`,
    );
    await header.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "SAT32 右侧详情没有头部",
    });
    expect(await header.getAttribute("data-status")).toBe("running");
    const hint = await $(`[data-testid="${TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT}"]`);
    await hint.waitForDisplayed({
      timeout: 5000,
      timeoutMsg: "SAT32 右侧没有只读提示",
    });

    const initialRows = await readChildRowCount(childSessionId);
    await browser.waitUntil(async () => (await readChildRowCount(childSessionId)) > initialRows, {
      timeout: 60000,
      timeoutMsg: "SAT32 右侧子会话没有实时增长",
    });
    // 步骤数随子工具调用出现（镜像计步，见规范「引擎无关合同」第 6 条）。
    await browser.waitUntil(
      async () => /\d+ (个步骤|steps?)/u.test((await readWorkCardState()).text),
      {
        timeout: 60000,
        timeoutMsg: "SAT31 工作卡没有显示步骤数",
      },
    );

    // SAT33：单个"停止"经父会话 cancelBackgroundWork；停止后卡片与详情头部收口。
    const stop = await $(`[data-testid="${TID_V4_SUBAGENT_WORK_CARD_STOP}-${childSessionId}"]`);
    await stop.click();
    await browser.waitUntil(
      async () => (await header.getAttribute("data-status")) === "cancelled",
      {
        timeout: 30000,
        timeoutMsg: "SAT33 详情头部没有变为已停止",
      },
    );
    await browser.waitUntil(async () => (await readWorkCardState()).state === "ended", {
      timeout: 30000,
      timeoutMsg: "SAT34 工作卡没有在全部结束后折叠",
    });
    const ended = await readWorkCardState();
    expect(ended.stopAll).toBe(0);
    expect(ended.openActions).toBe(0);
  });
});
