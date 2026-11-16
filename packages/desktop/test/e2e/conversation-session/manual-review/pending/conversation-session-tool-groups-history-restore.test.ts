import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  TID_MCP_SERVER_ROW,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  restoreCliConfig,
  seedCliConfig,
  snapshotCliConfig,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
  type CliConfigSnapshot,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import {
  listConversationToolGroups,
  type ConversationToolGroupSnapshot,
} from "../../../helpers/conversation-session-tool-groups.js";
import { ensureToolCrossProductFullAccessMode } from "../../../helpers/conversation-session-tool-cross-product.js";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "../../../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  clickV4TimelineBackToBottom,
  getV4FocusedPaneId,
  getV4PaneSnapshot,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  scrollV4TimelineToTop,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import {
  expandAssistantHistoriesWithContent,
  expandVisibleToolCallGroups,
} from "../../../helpers/conversation-session-tool-diagnostics.js";

const CASE_NAME = "conversation-session-tool-groups-history-restore";
const CASE_MARKER = "E2E_TOOL_GROUPS_HISTORY_RESTORE";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const READ_PATH = resolveE2EToolPath(CASE_NAME, "read.txt");
const SECOND_READ_PATH = resolveE2EToolPath(CASE_NAME, "read-second.txt");
const WRITE_PATH = resolveE2EToolPath(CASE_NAME, "write.ts");
const SECOND_WRITE_PATH = resolveE2EToolPath(CASE_NAME, "write-second.ts");

describe("TGE05 desktop tool groups history restore", () => {
  before(async function () {
    this.timeout(150000);
    await seedSettings({ toolGroupingChangesEnabled: true });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
  });

  afterEach(async () => {
    await rm(RUNTIME_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完整冷重启后保持 Explore、Terminal、Changes 的终态和顺序", async function () {
    this.timeout(240000);
    await prepareFixture();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      [
        `${CASE_MARKER}: Follow these tool steps in order.`,
        // 原准备只有每类一项，而既有三类分组都要求连续两项；不能为旧断言恢复单项空壳组。
        `1. Read ${READ_PATH}, then Read ${SECOND_READ_PATH}.`,
        `2. Bash exactly: node -e "console.log('TGE05_EXEC')", then node -e "console.log('TGE05_EXEC_SECOND')".`,
        `3. Write ${WRITE_PATH} and ${SECOND_WRITE_PATH}, each with exactly "export const restored = true;\\n".`,
        `4. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
      ].join(" "),
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 150000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "TGE05 工具轮没有结束", 150000);
    await expandAssistantHistoriesWithContent();
    const liveGroups = await waitForThreeCompletedGroups();
    expect(liveGroups.map((group) => group.toolName)).toEqual([
      "Explore",
      "ExecuteGroup",
      "ChangesGroup",
    ]);

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("TGE05 缺少 sessionId");
    await reloadAndRestoreSession(sessionId);
    await expandAssistantHistoriesWithContent();
    const restoredGroups = await waitForThreeCompletedGroups();

    expect(toStableGroupEvidence(restoredGroups)).toEqual(toStableGroupEvidence(liveGroups));
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
    const evidence = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (evidence) {
      // child 已挂载时展开动画仍可能裁切截图，等待有限动画结束后记录稳定画面。
      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-tool-name="Explore"], [data-tool-name="ExecuteGroup"], [data-tool-name="ChangesGroup"]',
              ),
            )
              .flatMap((group) => group.getAnimations({ subtree: true }))
              .every(
                (animation) =>
                  animation.playState !== "running" ||
                  animation.effect?.getTiming().iterations === Infinity,
              ),
          ),
        { timeout: 5000, timeoutMsg: "TGE05 分组展开动画未结束" },
      );
      await browser.saveScreenshot(join(evidence, "tge05-restored-groups.png"));
      await writeFile(
        join(evidence, "tge05-groups.json"),
        JSON.stringify({ liveGroups, restoredGroups }, null, 2),
      );
    }
  });
});

async function prepareFixture() {
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });
  await writeFile(join(RUNTIME_ROOT, "read.txt"), "TGE05_READ\n", "utf8");
  await writeFile(join(RUNTIME_ROOT, "read-second.txt"), "TGE05_READ_SECOND\n", "utf8");
}

async function waitForThreeCompletedGroups() {
  let latest: ConversationToolGroupSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await listConversationToolGroups();
      return latest.length === 3 && latest.every((group) => group.status === "completed");
    },
    { timeout: 60000, timeoutMsg: `TGE05 没有得到三个完成分组: ${JSON.stringify(latest)}` },
  );
  await expandVisibleToolCallGroups();
  await browser.waitUntil(
    async () => {
      latest = await listConversationToolGroups();
      return latest.length === 3 && latest.every((group) => group.childCount === 2);
    },
    { timeout: 15000, timeoutMsg: "TGE05 三类真实分组未各包含两个调用" },
  );
  return latest;
}

function toStableGroupEvidence(groups: ConversationToolGroupSnapshot[]) {
  return groups.map((group) => ({
    childCount: group.childCount,
    status: group.status,
    summaryText: group.summaryText,
    toolName: group.toolName,
  }));
}

async function reloadAndRestoreSession(sessionId: string, expectedText = E2E_REPLY_TOKEN) {
  await browser.reloadSession();
  await waitForRendererAfterReloadSession();
  await waitForDefaultWorkspaceReady(60000);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `TGE05 没有恢复 session ${sessionId}`,
    60000,
  );
  await waitForRestoredSessionStable(
    sessionId,
    "TGE05 cold restore 没有稳定显示原会话",
    expectedText,
  );
}

async function waitForRestoredSessionStable(
  sessionId: string,
  failureMessage: string,
  expectedText: string,
) {
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      const snapshot = await getV4PaneSnapshot();
      const matches =
        snapshot.sessionId === sessionId && snapshot.timelineText.includes(expectedText);
      if (!matches) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= 1000;
    },
    { timeout: 60000, timeoutMsg: failureMessage },
  );
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => target.url().includes("/renderer/index.html"))
          .at(-1);
        const targetId = rendererTarget
          ? (rendererTarget as unknown as { _targetId?: string })._targetId
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 30000, interval: 250, timeoutMsg: "TGE05 reload 后没有 renderer target" },
  );
}

const MCP_GATE_ROOT = join(RUNTIME_ROOT, "ux06-gates");
const groupSelector = (id: string) => `[data-tool-call-id="mcp-group:toolu_ux06_${id}"]`;
const groupTrigger = (id: string) =>
  `[data-testid="tool-summary-trigger-mcp-group:toolu_ux06_${id}"]`;
const childTrigger = (id: string) => `[data-testid="tool-summary-trigger-toolu_ux06_${id}"]`;

describe("UX06 MCP service tree disclosure", () => {
  let cliConfig: CliConfigSnapshot;
  before(async function () {
    this.timeout(150000);
    cliConfig = await snapshotCliConfig();
    await rm(MCP_GATE_ROOT, { recursive: true, force: true });
    await mkdir(MCP_GATE_ROOT, { recursive: true });
    const server = {
      type: "stdio",
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../../../fixtures/mcp/conversation-groups-server.mjs", import.meta.url),
        ),
      ],
      env: { E2E_MCP_GROUP_GATE_ROOT: MCP_GATE_ROOT },
    };
    await seedCliConfig({ mcp: { servers: { ux06_alpha: server, ux06_beta: server } } });
    await seedSettings({ locale: "zh-CN" });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    // 冷发现是后台启动；先走设置页的真实连接，避免回放在 schema 登记前调用工具。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"));
    for (const name of ["ux06_alpha", "ux06_beta"]) {
      const row = await browser.$(`[data-testid="${testId(TID_MCP_SERVER_ROW, name)}"]`);
      await browser.waitUntil(
        async () =>
          (await row.getAttribute("data-mcp-status")) === "connected" &&
          (await row.getAttribute("data-mcp-tool-count")) === "1",
        { timeout: 60000, timeoutMsg: `UX06 ${name} 未完成真实 MCP discovery` },
      );
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await browser.executeAsync((done: () => void) => {
      const actions = (
        window as typeof window & { __testActions?: { setTheme: (value: string) => void } }
      ).__testActions!;
      actions.setTheme("zai-light");
      requestAnimationFrame(() => done());
    });
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await restoreCliConfig(cliConfig);
    await clearAppData();
    await rm(MCP_GATE_ROOT, { recursive: true, force: true });
  });
  it("UX06 keeps manual MCP viewing and mixed errors outside completed history", async function () {
    this.timeout(240000);
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      "E2E_UX06_MCP_GROUPS: call the deterministic MCP tools in order and finish.",
    );
    await waitForMcpGate("a1");
    const first = await browser.$(groupTrigger("a1"));
    await first.waitForDisplayed();
    expect(await first.getAttribute("aria-expanded")).toBe("true");
    expect(await browser.$(childTrigger("a1")).getAttribute("aria-expanded")).toBe("true");
    await first.click();
    expect(await first.getAttribute("aria-expanded")).toBe("false");
    await releaseMcpGate("a1");
    await waitForMcpGate("a2");
    expect(await first.getAttribute("aria-expanded")).toBe("false");
    // 使用真实键盘，验证服务组与子调用的原生 disclosure 独立。
    await first.click();
    await browser.keys(" ");
    expect(await first.getAttribute("aria-expanded")).toBe("false");
    await browser.keys("Enter");
    expect(await first.getAttribute("aria-expanded")).toBe("true");
    const firstChild = await browser.$(childTrigger("a1"));
    expect(await firstChild.getAttribute("aria-expanded")).toBe("false");
    await firstChild.click();
    const secondChild = await browser.$(childTrigger("a2"));
    const beforeSecondClick = await browser.execute((selector) => {
      const button = document.querySelector(selector);
      return {
        expanded: button?.getAttribute("aria-expanded"),
        status: button?.closest("[data-tool-call-id]")?.getAttribute("data-status"),
      };
    }, childTrigger("a2"));
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir)
      await writeFile(
        join(artifactDir, "ux06-a2-click.json"),
        JSON.stringify({ before: beforeSecondClick }, null, 2),
      );
    // started gate 只证明 MCP 服务已执行，Renderer 仍可能是 pending；先验证运行默认展开再手动收起。
    await browser.waitUntil(
      async () => (await secondChild.getAttribute("aria-expanded")) === "true",
      {
        timeout: 15000,
        timeoutMsg: "UX06 a2 运行投影没有默认展开，不能把首次点击当作收起",
      },
    );
    await secondChild.click();
    const after = await secondChild.getAttribute("aria-expanded");
    if (artifactDir)
      await writeFile(
        join(artifactDir, "ux06-a2-click.json"),
        JSON.stringify({ before: beforeSecondClick, readyExpanded: "true", after }, null, 2),
      );
    expect(after).toBe("false");
    await releaseMcpGate("a2");
    await waitForMcpGate("b");
    expect(await first.getAttribute("aria-expanded")).toBe("true");
    expect(await firstChild.getAttribute("aria-expanded")).toBe("true");
    expect(await secondChild.getAttribute("aria-expanded")).toBe("false");
    await releaseMcpGate("b");
    await waitForMcpGate("a3");
    await waitForMcpGate("a4");
    await releaseMcpGate("a3");
    await releaseMcpGate("a4");
    await waitForV4AssistantMessageContaining("UX06_MCP_DONE", 60000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "UX06 parent turn 未结束", 60000);
    await browser.waitUntil(
      async () =>
        (await browser
          .$('[data-testid^="chat-assistant-history-trigger-"]')
          .getAttribute("data-history-open")) === "false",
      { timeout: 15000, timeoutMsg: "UX06 已工作外层没有默认收起" },
    );
    expect(await browser.$(groupSelector("a1")).isDisplayed()).toBe(true);
    expect(await browser.$(childTrigger("a1")).getAttribute("aria-expanded")).toBe("true");
    expect(await browser.$(groupSelector("a1")).getText()).toContain("UX06_RESULT:first");
    expect(await browser.$(groupSelector("b")).isDisplayed()).toBe(false);
    expect(await browser.$(groupTrigger("a3")).getAttribute("aria-expanded")).toBe("false");
    const errorSummary = await browser.$(
      `${groupSelector("a3")} [data-testid="mcp-group-error-summary"]`,
    );
    expect(await errorSummary.isDisplayed()).toBe(true);
    expect(await errorSummary.getText()).toContain("UX06_ERROR:failed");
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots)
      await browser.saveScreenshot(join(screenshots, "ux06-ended-manual-light-zh.png"));
    await expandAssistantHistoriesWithContent();
    const before = await mcpGroupEvidence();
    expect(before.map((item) => item.id)).toEqual([
      "mcp-group:toolu_ux06_a1",
      "mcp-group:toolu_ux06_b",
      "mcp-group:toolu_ux06_a3",
    ]);
    expect(before.map((item) => item.status)).toEqual(["completed", "completed", "failed"]);
    await assertMcpVirtualized();
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("UX06 missing real session");
    await reloadAndRestoreSession(sessionId, "UX06_HISTORY_DONE");
    const restoredPaneId = await getV4FocusedPaneId();
    if (!restoredPaneId) throw new Error("UX06 cold restore 缺少 focused pane");
    await scrollV4TimelineToTop(restoredPaneId);
    expect(
      await browser
        .$(`${groupSelector("a3")} [data-testid="mcp-group-error-summary"]`)
        .isDisplayed(),
    ).toBe(true);
    await expandAssistantHistoriesWithContent();
    expect(await mcpGroupEvidence()).toEqual(before);
    expect(await browser.$(groupTrigger("a1")).getAttribute("aria-expanded")).toBe("false");
    await verifyMcpNarrowPresentation();
  });
});

async function assertMcpVirtualized() {
  const paneId = await getV4FocusedPaneId();
  if (!paneId) throw new Error("UX06 缺少虚拟滚动目标 pane");
  const retained = await browser.$(groupSelector("a1"));
  await browser.execute((selector) => {
    (window as typeof window & { __ux06GroupProbe?: Element }).__ux06GroupProbe =
      document.querySelector(selector)!;
  }, groupSelector("a1"));
  try {
    for (let index = 2; index <= 14; index += 1) {
      if ((await getV4TimelineScrollState(paneId)).hasBackToBottom)
        await clickV4TimelineBackToBottom();
      const prompt = `E2E_UX06_HISTORY_${String(index).padStart(3, "0")}`;
      await sendV4Prompt(prompt);
      await browser.waitUntil(
        async () =>
          browser.execute(
            (id, count, marker) => {
              const timeline = document.querySelector(
                `[data-testid="v4-session-pane-${id}"] [data-testid="v4-timeline"]`,
              );
              const last = Array.from(
                timeline?.querySelectorAll('[data-v4-turn-unit="true"]') ?? [],
              ).at(-1);
              return (
                Number(timeline?.getAttribute("data-render-unit-count")) === count &&
                Boolean(
                  last?.textContent?.includes(marker) &&
                  last.textContent.includes("UX06_HISTORY_DONE"),
                )
              );
            },
            paneId,
            index,
            prompt,
          ),
        { timeout: 30000, timeoutMsg: `UX06 第 ${index} 个真实历史 turn 未完成` },
      );
      await waitForV4Pane((snapshot) => !snapshot.canStop, "UX06 历史 turn 未回到空闲");
    }
    if ((await getV4TimelineScrollState(paneId)).hasBackToBottom)
      await clickV4TimelineBackToBottom();
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const probe = (window as typeof window & { __ux06GroupProbe?: Element }).__ux06GroupProbe;
          return Boolean(probe && !probe.isConnected && !document.querySelector(selector));
        }, groupSelector("a1")),
      { timeout: 15000, timeoutMsg: "UX06 MCP 首轮仍挂载，未证明真实 virtualizer 卸载" },
    );
    const unmounted = await getV4TimelineScrollState(paneId);
    expect(unmounted.renderUnitCount).toBe(14);
    expect(unmounted.mountedRenderUnitCount).toBeLessThan(14);
    expect(await retained.isExisting()).toBe(false);
    await scrollV4TimelineToTop(paneId);
    const first = await browser.$(groupTrigger("a1"));
    await first.waitForDisplayed();
    expect(await first.getAttribute("aria-expanded")).toBe("true");
    expect(await browser.$(childTrigger("a1")).getAttribute("aria-expanded")).toBe("true");
    expect(await browser.$(childTrigger("a2")).getAttribute("aria-expanded")).toBe("false");
    expect(
      await browser.execute(
        (selector) =>
          document.querySelector(selector) !==
          (window as typeof window & { __ux06GroupProbe?: Element }).__ux06GroupProbe,
        groupSelector("a1"),
      ),
    ).toBe(true);
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots) {
      await browser.saveScreenshot(join(screenshots, "ux06-virtual-remount.png"));
      await writeFile(
        join(screenshots, "ux06-virtual-remount.json"),
        JSON.stringify({ unmounted, remounted: await getV4TimelineScrollState(paneId) }, null, 2),
      );
    }
  } finally {
    await browser.execute(() => {
      delete (window as typeof window & { __ux06GroupProbe?: Element }).__ux06GroupProbe;
    });
  }
}

async function waitForMcpGate(id: string) {
  await browser.waitUntil(
    () =>
      access(join(MCP_GATE_ROOT, `${id}.started`)).then(
        () => true,
        () => false,
      ),
    { timeout: 60000, timeoutMsg: `UX06 MCP ${id} 未真实启动` },
  );
}
async function releaseMcpGate(id: string) {
  await writeFile(join(MCP_GATE_ROOT, `${id}.release`), "release");
}
async function mcpGroupEvidence() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-tool-name="McpGroup"]')).map((node) => ({
      id: node.getAttribute("data-tool-call-id"),
      status: node.getAttribute("data-status"),
      summary: node.querySelector('[data-testid^="tool-summary-trigger-"]')?.textContent,
    })),
  );
}
async function verifyMcpNarrowPresentation() {
  const original = await setCurrentElectronRendererContentSize(1280, 900);
  const minimum = await browser.electron.execute((electron, id) => {
    const window = electron.BrowserWindow.fromId(id)!;
    const previous = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return previous;
  }, original.windowId);
  try {
    await setCurrentElectronRendererContentSize(430, 900);
    await browser.executeAsync((done: () => void) => {
      const actions = (
        window as typeof window & {
          __testActions?: { setLocale: (value: string) => void; setTheme: (value: string) => void };
        }
      ).__testActions!;
      actions.setLocale("en-US");
      actions.setTheme("zai-dark");
      requestAnimationFrame(() => done());
    });
    const drawer = await browser.$('[data-testid="workspace-sidebar-drawer-backdrop"]');
    if (await drawer.isDisplayed()) {
      await browser.action("pointer").move({ x: 420, y: 450 }).down().up().perform();
      await drawer.waitForDisplayed({ reverse: true });
    }
    const summary = await browser.$(groupTrigger("a3"));
    await summary.scrollIntoView();
    expect(await summary.getText()).toContain("2 calls");
    expect(await summary.getText()).toContain("Failed");
    const layout = await browser.execute(() => ({
      width: innerWidth,
      groups: Array.from(document.querySelectorAll('[data-tool-name="McpGroup"]')).map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }),
    }));
    expect(Math.abs(layout.width - 430)).toBeLessThanOrEqual(1);
    for (const rect of layout.groups) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(layout.width + 1);
    }
    const screenshots = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
    if (screenshots) {
      await browser.saveScreenshot(join(screenshots, "ux06-narrow-dark-en.png"));
      await writeFile(join(screenshots, "ux06-layout.json"), JSON.stringify(layout, null, 2));
    }
  } finally {
    await browser.electron.execute(
      (electron, id, min) => electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
      original.windowId,
      minimum,
    );
    await restoreElectronRendererContentSize(original);
  }
}
