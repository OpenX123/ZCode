import {
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_SESSION_HEADER,
  TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT,
  TID_V4_SUBAGENT_WORK_CARD,
  TID_V4_SUBAGENT_WORK_CARD_STOP,
  TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
} from "@zcode/shared/test-ids";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readSubagentRows } from "../../../helpers/subagent-refresh-capture.js";
import {
  clearAppData,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "../../../helpers/desktop-app.js";
import { Key } from "webdriverio";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  getV4FocusedPaneId,
  getV4PaneSnapshot,
  startNewV4Draft,
  selectV4TaskById,
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
      ).filter((node) => node.getClientRects().length > 0);
      const card = cards[0];
      return {
        cards: cards.length,
        state: card?.dataset.state ?? "",
        memberCount: Number(card?.dataset.memberCount ?? "0"),
        openActions: card?.querySelectorAll(`[data-testid^="${openPrefix}-"]`).length ?? 0,
        stopAll: card?.querySelectorAll(`[data-testid^="${stopAllPrefix}-"]`).length ?? 0,
        // 修复原因：成员“停止”前缀 `…-stop-` 同时匹配“停止全部” `…-stop-all-`，旧计数恒多 1。
        memberStops:
          card?.querySelectorAll(
            `[data-testid^="${stopPrefix}-"]:not([data-testid^="${stopAllPrefix}-"])`,
          ).length ?? 0,
        text: card?.textContent ?? "",
      };
    },
    TID_V4_SUBAGENT_WORK_CARD,
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
    TID_V4_SUBAGENT_WORK_CARD_STOP,
  );
}

/** 首个「已工作 N 秒」摘要的展开态；没有摘要（轮次未结束）时为空串。 */
async function readHistoryOpen(paneId?: string): Promise<string> {
  return browser.execute(
    (id) =>
      (id ? document.querySelector(`[data-testid="v4-session-pane-${id}"]`) : document)
        ?.querySelector<HTMLElement>('[data-testid^="chat-assistant-history-trigger-"]')
        ?.getAttribute("data-history-open") ?? "",
    paneId,
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

function readBuiltinWorkCardParts(parentSessionId: string) {
  const parentParts = readSubagentRows(
    "SELECT data FROM part WHERE session_id = ?",
    parentSessionId,
  )
    .map((row) => JSON.parse(String(row.data)) as Record<string, unknown>)
    .filter(
      (part) =>
        part.type === "tool" &&
        ["toolu_ux08_agent_a", "toolu_ux08_agent_b"].includes(String(part.callID)),
    );
  const children = readSubagentRows(
    "SELECT id, title FROM session WHERE parent_id = ? ORDER BY title",
    parentSessionId,
  ).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    parts: readSubagentRows("SELECT data FROM part WHERE session_id = ?", String(row.id)).map(
      (part) => JSON.parse(String(part.data)) as Record<string, unknown>,
    ),
  }));
  return { parentParts, children };
}

/** 只读取真实 Timeline 输入，不将 DOM 文案或工作卡派生 model 当作上游事实。 */
async function readBuiltinTimelineRows(paneId: string) {
  return browser.execute((id) => {
    interface Fiber {
      memoizedProps?: { rows?: Array<Record<string, unknown>>; sessionKey?: string };
      return?: Fiber;
    }
    const timeline = document.querySelector(
      `[data-testid="v4-session-pane-${id}"] [data-testid="v4-timeline"]`,
    );
    if (!timeline) throw new Error("UX08 缺少 Timeline");
    const key = Object.keys(timeline).find((value) => value.startsWith("__reactFiber$"));
    let fiber = key ? (timeline as unknown as Record<string, Fiber>)[key] : undefined;
    while (fiber) {
      const props = fiber.memoizedProps;
      if (Array.isArray(props?.rows) && props?.sessionKey) {
        return props.rows
          .filter((row) => row.kind === "subagent")
          .map((row) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
      }
      fiber = fiber.return;
    }
    throw new Error("UX08 React 结构已变化，未找到真实 Timeline rows");
  }, paneId);
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
    expect((await readWorkCardState()).text).toContain("E2E work card child");
    const activity = $('[data-testid="subagent-activity-trigger"]');
    await activity.waitForDisplayed();
    expect(await activity.getAttribute("aria-label")).toContain("运行中");
    const toggle = $('[data-testid^="v4-subagent-work-card-toggle-"]');
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await toggle.getText()).toContain("运行中");
    await activity.waitForDisplayed();
    await toggle.click();
    // MA15：父轮结束后「已工作 N 秒」收起其它工作项，运行中的工作卡仍在折叠摘要之下可见。
    await browser.waitUntil(async () => (await readHistoryOpen()) === "false", {
      timeout: 30000,
      timeoutMsg: "SAT31 父轮结束后应出现收起的「已工作」摘要",
    });
    expect((await readWorkCardState()).state).toBe("running");

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
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir) {
      await browser.saveScreenshot(join(artifactDir, "subagent-work-card-running-side-pane.png"));
    }

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
    // UX08：手动打开跨终态保留，外层“已工作”不得吞掉正在看的卡；详情也不关闭。
    await browser.waitUntil(async () => (await readWorkCardState()).state === "ended", {
      timeout: 30000,
      timeoutMsg: "SAT34 工作卡没有在全部结束后折叠",
    });
    const ended = await readWorkCardState();
    expect(ended.stopAll).toBe(0);
    expect(ended.openActions).toBe(1);
    await activity.waitForExist({ reverse: true });
    expect(await header.isDisplayed()).toBe(true);
    expect(await readHistoryOpen()).toBe("false");
    if (artifactDir)
      await browser.saveScreenshot(join(artifactDir, "ux08-cancelled-keeps-detail.png"));
  });

  it("UX08 lifecycle: partial completion → all ended → retained detail → refresh; light/dark, languages, narrow keyboard", async function () {
    this.timeout(TIMEOUT_MS);
    await startNewV4Draft();
    await sendV4Prompt(
      "E2E_UX08_LIFECYCLE: launch two background Explore agents A and B and immediately reply UX08_LAUNCHED.",
    );
    await waitForV4AssistantMessageContaining("UX08_LAUNCHED");
    const parentPaneId = await getV4FocusedPaneId();
    if (!parentPaneId) throw new Error("UX08 缺少 focused parent pane");
    const parentSessionId = (await getV4PaneSnapshot(parentPaneId)).sessionId;
    if (!parentSessionId || parentSessionId === "draft") throw new Error("UX08 缺少父会话");
    const pane = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
    const card = await pane.$('[data-testid^="v4-subagent-work-card-"][data-member-count="2"]');
    await card.waitForDisplayed({ timeout: 60000 });
    const toggle = await card.$('[data-testid^="v4-subagent-work-card-toggle-"]');
    await toggle.click();
    await toggle.click();
    const members = await card.$$('[data-testid^="v4-subagent-open-side-pane-"]');
    const child = members[1]!;
    const childSessionId = (await child.getAttribute("data-child-session-id"))!;
    await child.click();
    const header = await $(
      `[data-testid="${TID_V4_SUBAGENT_SESSION_HEADER}"][data-child-session-id="${childSessionId}"]`,
    );
    await header.waitForDisplayed();
    const activity = await pane.$('[data-testid="subagent-activity-trigger"]');
    await browser.waitUntil(
      async () => (await activity.getAttribute("aria-label"))?.includes("已结束 1") === true,
      { timeout: 60000, timeoutMsg: "UX08 部分完成后活动入口应保留" },
    );
    expect(await activity.isDisplayed()).toBe(true);
    await browser.waitUntil(async () => (await card.getAttribute("data-state")) === "ended", {
      timeout: 60000,
    });
    await activity.waitForExist({ reverse: true });
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await header.isDisplayed()).toBe(true);
    const persisted = readBuiltinWorkCardParts(parentSessionId);
    const liveRows = await readBuiltinTimelineRows(parentPaneId);
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir)
      await writeFile(
        join(artifactDir, "ux08-persisted-sqlite-live-rows.json"),
        JSON.stringify({ persisted, liveRows }, null, 2),
      );
    expect(persisted.parentParts).toHaveLength(2);
    for (const [index, label] of ["A", "B"].entries()) {
      const part = persisted.parentParts.find(
        (value) => value.callID === `toolu_ux08_agent_${label.toLowerCase()}`,
      )!;
      const state = part.state as { output: string; metadata?: { summaryText?: string } };
      expect(state.output).toContain("Async agent launched successfully");
      expect(state.output).not.toContain(`UX08_RESULT_${label}`);
      expect(state.metadata?.summaryText).toBeUndefined();
      const childParts = persisted.children[index]!.parts;
      expect(
        childParts.filter(
          (value) => value.type === "text" && value.text === `UX08_RESULT_${label}`,
        ),
      ).toHaveLength(1);
      expect(
        liveRows.find((row) => row.parentToolCallId === `toolu_ux08_agent_${label.toLowerCase()}`),
      ).toMatchObject({ status: "success", summaryText: `UX08 task ${label}` });
    }
    expect((await card.getText()).match(/已完成，可查看过程/gu)).toHaveLength(2);
    expect(await card.getText()).not.toContain("结果：");
    await browser.waitUntil(
      async () =>
        (await $(`[data-session-id="${childSessionId}"]`).getText()).includes("UX08_RESULT_B"),
      { timeout: 30000, timeoutMsg: "UX08 子任务详情缺少真实最终正文" },
    );
    expect(await readHistoryOpen(parentPaneId)).toBe("false");
    if (artifactDir)
      await browser.saveScreenshot(join(artifactDir, "ux08-success-retained-detail.png"));

    // 原生 Shift+Tab/Enter：从第二成员回到第一成员，不能程序 focus 冒充导航。
    await child.click();
    await browser.action("key").down(Key.Shift).down(Key.Tab).up(Key.Tab).up(Key.Shift).perform();
    const first = members[0]!;
    expect(await first.isFocused()).toBe(true);
    await browser.keys(Key.Enter);
    const firstId = (await first.getAttribute("data-child-session-id"))!;
    await $(
      `[data-testid="${TID_V4_SUBAGENT_SESSION_HEADER}"][data-child-session-id="${firstId}"]`,
    ).waitForDisplayed();

    // 详情关闭只由显式用户动作触发；汇总退场前后没有任何关闭/停止命令。
    await startNewV4Draft();
    await selectV4TaskById(parentSessionId);
    await browser.refresh();
    await pane.waitForDisplayed({ timeout: 30000 });
    expect(await pane.$('[data-testid="subagent-activity-trigger"]').isExisting()).toBe(false);
    const history = await pane.$('[data-testid^="chat-assistant-history-trigger-"]');
    await history.click();
    await card.waitForDisplayed();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    expect((await card.getText()).match(/已完成，可查看过程/gu)).toHaveLength(2);
    expect(await card.getText()).toContain("查看结果");
    const refreshedRows = await readBuiltinTimelineRows(parentPaneId);
    expect(refreshedRows).toEqual(liveRows);
    if (artifactDir)
      await writeFile(
        join(artifactDir, "ux08-renderer-refresh-rows.json"),
        JSON.stringify({ refreshedRows }, null, 2),
      );
    await verifyUx08Appearance(card, artifactDir);
  });
});

async function verifyUx08Appearance(
  card: Awaited<ReturnType<typeof browser.$>>,
  artifactDir?: string,
) {
  const previous = await setCurrentElectronRendererContentSize(1280, 900);
  const minimum = await browser.electron.execute((electron, id) => {
    const window = electron.BrowserWindow.fromId(id)!;
    const value = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return value;
  }, previous.windowId);
  try {
    for (const [locale, theme, width] of [
      ["zh-CN", "zai-light", 1280],
      ["en-US", "zai-dark", 430],
    ] as const) {
      await browser.execute(
        (language, color) => {
          const actions = (
            window as unknown as Window & {
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
      await card.scrollIntoView();
      const layout = await browser.execute((node) => {
        const rect = node.getBoundingClientRect();
        return {
          width: window.innerWidth,
          left: rect.left,
          right: rect.right,
          cardWidth: rect.width,
        };
      }, card);
      // Windows content size 与 renderer 各允许 1px 舍入；布局边界始终按实际 viewport 验证。
      expect(Math.abs(layout.width - width)).toBeLessThanOrEqual(2);
      expect(layout.cardWidth).toBeGreaterThan(0);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(layout.width + 1);
      expect(await card.getText()).toContain(locale === "zh-CN" ? "查看结果" : "View result");
      if (artifactDir) {
        await writeFile(
          join(artifactDir, `ux08-layout-${width}.json`),
          JSON.stringify({ requestedWidth: width, ...layout }, null, 2),
        );
        await browser.saveScreenshot(join(artifactDir, `ux08-${theme}-${locale}-${width}.png`));
      }
    }
  } finally {
    await browser.electron.execute(
      (electron, id, min) => electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
      previous.windowId,
      minimum,
    );
    await restoreElectronRendererContentSize(previous);
  }
}
