import {
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_SUBAGENT_SESSION_HEADER,
  TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT,
  TID_V4_SUBAGENT_WORK_CARD,
  TID_V4_SUBAGENT_WORK_CARD_STOP,
  TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
} from "@zcode/shared/test-ids";
import { dirname, join } from "node:path";
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
import { assertCacheRecoveryPackagedAgentProof } from "../../../helpers/cache-recovery-native-observers.js";

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
const SUMMARY = '[data-testid="chat-summary-panel"]';
const variantInput = process.env.ZCODE_E2E_TASK13_STATUS_PANEL_VARIANT ?? "auto";
if (variantInput !== "auto" && variantInput !== "panel") {
  throw new Error("ZCODE_E2E_TASK13_STATUS_PANEL_VARIANT 只允许 auto|panel");
}
const ux08Variant = variantInput;

interface WorkCardState {
  cards: number;
  state: string;
  memberCount: number;
  openActions: number;
  stopAll: number;
  memberStops: number;
  text: string;
}

export async function readWorkCardState(paneId: string): Promise<WorkCardState> {
  return browser.execute(
    (parentId, cardPrefix, openPrefix, stopAllPrefix, stopPrefix) => {
      // 原全局首项会读到缓存/child 的卡；保存的父 pane 是本次断言的唯一作用域。
      const pane = document.querySelector(`[data-testid="v4-session-pane-${parentId}"]`);
      if (!pane) throw new Error("工作卡缺少指定父 pane");
      // 卡片根带 data-member-count；同前缀的停止 / 折叠按钮不计入卡片数。
      const cards = Array.from(
        pane.querySelectorAll<HTMLElement>(`[data-testid^="${cardPrefix}-"][data-member-count]`),
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
    paneId,
    TID_V4_SUBAGENT_WORK_CARD,
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    TID_V4_SUBAGENT_WORK_CARD_STOP_ALL,
    TID_V4_SUBAGENT_WORK_CARD_STOP,
  );
}

/** 首个「已工作 N 秒」摘要的展开态；没有摘要（轮次未结束）时为空串。 */
export async function readHistoryOpen(paneId: string): Promise<string> {
  return browser.execute(
    (id) =>
      document
        .querySelector(`[data-testid="v4-session-pane-${id}"]`)
        ?.querySelector<HTMLElement>('[data-testid^="chat-assistant-history-trigger-"]')
        ?.getAttribute("data-history-open") ?? "",
    paneId,
  );
}

export async function readChildRowCount(childSessionId: string, tabId: string): Promise<number> {
  return browser.execute(
    (sessionId, id) => {
      // 同 session 可能有隐藏缓存；完整 tab 身份必须仍绑定原 child，不能按 first 匹配。
      const pane = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]'),
      ).find((node) => node.getAttribute("data-testid") === `v4-session-pane-${id}`);
      if (pane?.dataset.sessionId !== sessionId) throw new Error("原 tab 没有绑定指定 child");
      return Number(
        pane?.querySelector<HTMLElement>('[data-testid="v4-timeline"]')?.dataset.rowCount ?? 0,
      );
    },
    childSessionId,
    tabId,
  );
}

async function visibleParentPaneId(sessionId: string) {
  return browser.execute((id) => {
    const panes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]'),
    ).filter(
      (node) =>
        node.dataset.sessionId === id &&
        node.checkVisibility() &&
        node.getBoundingClientRect().width > 0,
    );
    if (panes.length !== 1)
      throw new Error(`父 session 的可见 pane 必须唯一，实际 ${panes.length}`);
    return panes[0]!.dataset.testid!.slice("v4-session-pane-".length);
  }, sessionId);
}

interface ChildIdentity {
  childSessionId: string;
  tabId: string;
}

interface PreferenceActions {
  getLocale(): "zh-CN" | "en-US";
  getTheme(): string;
  setLocale(value: "zh-CN" | "en-US"): void;
  setTheme(value: string): void;
}

async function readChildIdentity(childSessionId: string) {
  return browser.execute(
    (sessionId, headerId) => {
      const headers = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${headerId}"]`),
      ).filter(
        (node) =>
          node.dataset.childSessionId === sessionId &&
          node.checkVisibility() &&
          node.getBoundingClientRect().width > 0,
      );
      if (headers.length !== 1)
        throw new Error(`可见原 child header 必须唯一，实际 ${headers.length}`);
      const header = headers[0]!;
      const panes = Array.from(
        header.parentElement!.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]'),
      ).filter((node) => node.dataset.sessionId === sessionId);
      if (panes.length !== 1) throw new Error("原 child header 没有唯一关联的正文 pane");
      const tabId = panes[0]!.dataset.testid!.slice("v4-session-pane-".length);
      const tabs = Array.from(
        document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).filter((node) => node.dataset.sidePaneTabId === tabId);
      if (tabs.length !== 1 || tabs[0]!.dataset.state !== "active")
        throw new Error("原 child 完整 tab 身份未激活");
      return { childSessionId: sessionId, tabId, status: header.dataset.status ?? "" };
    },
    childSessionId,
    TID_V4_SUBAGENT_SESSION_HEADER,
  );
}

async function assertRetainedChild(original: ChildIdentity, status: string, finalText?: string) {
  expect(await readChildIdentity(original.childSessionId)).toEqual({ ...original, status });
  const childPane = await $(
    `[data-testid="${await browser.execute((id) => `v4-session-pane-${CSS.escape(id)}`, original.tabId)}"]`,
  );
  await childPane.waitForDisplayed();
  expect(await childPane.getAttribute("data-session-id")).toBe(original.childSessionId);
  if (finalText) {
    await browser.waitUntil(async () => (await childPane.getText()).includes(finalText), {
      timeout: 30000,
      timeoutMsg: "原 child tab 缺少真实最终正文",
    });
  }
  return {
    ...original,
    status,
    finalTextPresent: finalText ? (await childPane.getText()).includes(finalText) : null,
  };
}

/** 只读当前 React 树的原 props；不调用 setter，不以 DOM 消失反推业务终态。 */
async function readTask13Facts(parentPaneId: string, parentSessionId: string) {
  const facts = await browser.execute(
    (paneId, sessionId) => {
      type Fiber = {
        memoizedProps?: Record<string, unknown>;
        child?: Fiber;
        sibling?: Fiber;
        return?: Fiber;
        stateNode?: { current?: Fiber };
      };
      const pane = document.querySelector<HTMLElement>(`[data-testid="v4-session-pane-${paneId}"]`);
      if (!pane || pane.dataset.sessionId !== sessionId || !pane.checkVisibility())
        throw new Error("Task13 父作用域已漂移");
      const key = Object.keys(pane).find((value) => value.startsWith("__reactFiber$"));
      let root = key ? (pane as unknown as Record<string, Fiber>)[key] : undefined;
      while (root?.return) root = root.return;
      root = root?.stateNode?.current ?? root;
      const stack = root ? [root] : [];
      let summary: Record<string, unknown> | undefined;
      let layout: { sidebar: boolean; sidePane: boolean } | undefined;
      while (stack.length) {
        const node = stack.pop()!;
        const props = node.memoizedProps;
        if (
          props?.parentSessionId === sessionId &&
          "endedSubagentCount" in props &&
          "summaryPanelVariantOverride" in props
        ) {
          if (summary) throw new Error("Task13 状态 props 歧义");
          summary = props;
        }
        if (
          typeof props?.isSidebarVisible === "boolean" &&
          typeof props.isSidePaneOpen === "boolean"
        ) {
          layout = { sidebar: props.isSidebarVisible, sidePane: props.isSidePaneOpen };
        }
        if (node.sibling) stack.push(node.sibling);
        if (node.child) stack.push(node.child);
      }
      if (!summary || !layout) throw new Error("Task13 缺少原状态/布局只读 props");
      const git = summary.gitSummary as { isRepository?: boolean; isDirty?: boolean } | null;
      const changes = summary.gitWorktreeChangeSummary as {
        added?: number;
        removed?: number;
      } | null;
      const works = (summary.backgroundWorks ?? []) as Array<{ kind: string; status: string }>;
      const container = pane.querySelector<HTMLElement>('[class~="@container/conversation"]');
      if (!container) throw new Error("Task13 缺少真实 conversation container");
      return {
        parentPaneId: paneId,
        parentSessionId: sessionId,
        mode: summary.summaryPanelVariantOverride ?? "auto",
        endedAgents: Number(summary.endedSubagentCount ?? 0),
        runningAgents: ((summary.runningSubagents ?? []) as unknown[]).length,
        runningBackground: works.filter((work) => work.status === "running").length,
        runningTerminals: works.filter((work) => work.kind === "bash" && work.status === "running")
          .length,
        workflows: ((summary.workflowRuns ?? []) as unknown[]).length,
        endedWorkflows: Number(summary.endedWorkflowRunCount ?? 0),
        hasGoal: Boolean(summary.goal),
        hasTodo: Boolean(summary.plan),
        sessionPlanCount: ((summary.sessionPlans ?? []) as unknown[]).length,
        hasGitChanges: Boolean(
          git?.isRepository &&
          (git.isDirty ||
            Number(summary.gitDirtyFileCount ?? 0) > 0 ||
            Number(changes?.added ?? 0) + Number(changes?.removed ?? 0) > 0),
        ),
        shellCount: pane.querySelectorAll('[data-testid="chat-summary-panel"]').length,
        activityCount: pane.querySelectorAll('[data-testid="subagent-activity-trigger"]').length,
        conversationWidth: container.getBoundingClientRect().width,
        window: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        layout,
      };
    },
    parentPaneId,
    parentSessionId,
  );
  const zoom = await browser.electron.execute(
    (electron, url) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (entry) => entry.webContents.getURL() === url,
      );
      if (!window) throw new Error("Task13 实际窗口不存在");
      return {
        zoomFactor: window.webContents.getZoomFactor(),
        contentSize: window.getContentSize(),
      };
    },
    await browser.getUrl(),
  );
  return { ...facts, ...zoom };
}

async function assertEndedOnly(parentPaneId: string, parentSessionId: string, count: number) {
  const facts = await readTask13Facts(parentPaneId, parentSessionId);
  expect(facts).toMatchObject({
    endedAgents: count,
    runningAgents: 0,
    runningBackground: 0,
    runningTerminals: 0,
    workflows: 0,
    endedWorkflows: 0,
    hasGoal: false,
    hasTodo: false,
    sessionPlanCount: 0,
    hasGitChanges: false,
  });
  const rows = await readBuiltinTimelineRows(parentPaneId);
  expect(rows).toHaveLength(count);
  expect(rows.every((row) => row.status === "success" || row.status === "cancelled")).toBe(true);
  return facts;
}

async function selectDisplayMode(parentPaneId: string, mode: "mini" | "auto" | "panel") {
  const pane = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
  const shell = await pane.$(SUMMARY);
  // auto 宽容器已展开，摘要按钮被 CSS 隐藏；先用原收起按钮进入可点击的 mini。
  const collapse = await shell.$('button[aria-label="收起为胶囊"]');
  if (await collapse.isDisplayed()) await collapse.click();
  const metric = await shell.$('[data-status-summary-item="agents"]');
  await metric.waitForDisplayed();
  await metric.$("..").click();
  expect(await shell.getAttribute("data-display-mode")).toBe("panel");
  if (mode === "auto") {
    await shell.$('button[aria-label="状态面板展开策略"]').click();
    const option = await $('[role="menuitemradio"]');
    expect(await option.getText()).toBe("自动展开");
    await option.click();
  } else if (mode === "mini") {
    await shell.$('button[aria-label="收起为胶囊"]').click();
  }
  expect(await shell.getAttribute("data-display-mode")).toBe(mode);
  expect(Number(await shell.getAttribute("data-running-agent-count"))).toBeGreaterThan(0);
}

async function writeEvidence(name: string, facts: unknown) {
  const dir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (dir) await writeFile(join(dir, name), JSON.stringify(facts, null, 2));
}

async function captureLayout() {
  return browser.execute(() => ({
    sidebar:
      document.querySelector<HTMLElement>('[data-testid="sidebar"]')?.checkVisibility() ?? false,
    sidePaneLabel: document
      .querySelector('[data-testid="side-pane-toggle"]')
      ?.getAttribute("aria-label"),
  }));
}

type CleanupRegister = (name: string, run: () => Promise<unknown>) => void;
interface CleanupOutcome {
  primaryCaptured: boolean;
  primary: unknown;
  cleanup: Array<{ name: string; error?: unknown }>;
}

/** R102：真实case共用此控制层；主异常和每项清理独立保全，不能用finally覆盖。 */
export async function runTask13WithCleanup(
  body: (register: CleanupRegister) => Promise<void>,
  record?: (outcome: CleanupOutcome, stage: "primary" | "complete") => Promise<void>,
) {
  const steps: Array<{ name: string; run: () => Promise<unknown> }> = [];
  const outcome: CleanupOutcome = { primaryCaptured: false, primary: undefined, cleanup: [] };
  try {
    await body((name, run) => steps.push({ name, run }));
  } catch (error) {
    outcome.primaryCaptured = true;
    outcome.primary = error;
    try {
      await record?.(outcome, "primary");
    } catch (evidence) {
      outcome.cleanup.push({ name: "primary-evidence", error: evidence });
    }
  } finally {
    for (const step of steps) {
      try {
        await step.run();
        outcome.cleanup.push({ name: step.name });
      } catch (error) {
        outcome.cleanup.push({ name: step.name, error });
      }
    }
    try {
      await record?.(outcome, "complete");
    } catch (error) {
      outcome.cleanup.push({ name: "evidence", error });
    }
  }
  const secondary = outcome.cleanup.filter((step) => "error" in step).map((step) => step.error);
  if (outcome.primaryCaptured) {
    if (secondary.length)
      throw new AggregateError(
        [outcome.primary, ...secondary],
        outcome.primary instanceof Error ? outcome.primary.message : "Task13 primary失败",
        { cause: outcome.primary },
      );
    throw outcome.primary;
  }
  if (secondary.length) throw new AggregateError(secondary, "Task13 cleanup失败");
}

function safeDiagnosticError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return { name: typeof error };
  return {
    name: error.name,
    // 只落本测试自己的尺寸错误；其余原始异常由runner保留，不将任意DOM/输入复制到诊断。
    message: /^(Electron renderer content size|renderer viewport|Task13 )/.test(error.message)
      ? error.message.split("\n")[0]!.slice(0, 600)
      : "原始异常保留在runner",
    frames: error.stack
      ?.split("\n")
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 8),
    ...(depth < 2 && error.cause ? { cause: safeDiagnosticError(error.cause, depth + 1) } : {}),
    ...(depth < 2 && error instanceof AggregateError
      ? { errors: error.errors.slice(0, 8).map((nested) => safeDiagnosticError(nested, depth + 1)) }
      : {}),
  };
}

function createTask13Diagnostics(label: string) {
  let windowId = 0;
  let dropped = 0;
  const samples: unknown[] = [];
  const diagnosticErrors: unknown[] = [];
  const checkpoint = async (phase: string, expected?: { width: number; height: number }) => {
    if (samples.length >= 24) {
      dropped++;
      return;
    }
    try {
      const currentUrl = windowId === 0 ? await browser.getUrl() : "";
      const native = await browser.electron.execute(
        (electron, id, url) => {
          const target =
            id === 0
              ? electron.BrowserWindow.getAllWindows().find(
                  (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === url,
                )
              : electron.BrowserWindow.fromId(id);
          if (!target || target.isDestroyed()) return { destroyed: true as const, windowId: id };
          return {
            destroyed: false as const,
            windowId: target.id,
            webContentsId: target.webContents.id,
            contentSize: target.getContentSize(),
            contentBounds: target.getContentBounds(),
            bounds: target.getBounds(),
            normalBounds: target.getNormalBounds(),
            maximized: target.isMaximized(),
            fullscreen: target.isFullScreen(),
            minimized: target.isMinimized(),
            minimumSize: target.getMinimumSize(),
            maximumSize: target.getMaximumSize(),
            zoomFactor: target.webContents.getZoomFactor(),
          };
        },
        windowId,
        currentUrl,
      );
      windowId = native.windowId;
      const renderer = await browser.execute(() => ({
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      }));
      samples.push({ phase, expected, at: new Date().toISOString(), native, renderer });
      await writeEvidence(`task13-${label}-window-state.json`, { samples, dropped });
    } catch (error) {
      diagnosticErrors.push(error);
    }
  };
  return {
    checkpoint,
    register(register: CleanupRegister, name: string, run: () => Promise<unknown>) {
      register(name, async () => {
        await checkpoint(`cleanup:${name}:before`);
        try {
          return await run();
        } finally {
          await checkpoint(`cleanup:${name}:after`);
        }
      });
    },
    async record(scope: string, outcome: CleanupOutcome) {
      await writeEvidence(`task13-${label}-${scope}-errors.json`, {
        primaryCaptured: outcome.primaryCaptured,
        primary: safeDiagnosticError(outcome.primary),
        cleanup: outcome.cleanup.map((step) => ({
          name: step.name,
          failed: "error" in step,
          error: safeDiagnosticError(step.error),
        })),
        diagnosticErrors: diagnosticErrors.map((error) => safeDiagnosticError(error)),
      });
      if (diagnosticErrors.length)
        throw new AggregateError(diagnosticErrors.splice(0), "Task13 diagnostic失败");
    },
  };
}

function registerLayoutCleanup(
  register: CleanupRegister,
  diagnostics: ReturnType<typeof createTask13Diagnostics>,
  original: Awaited<ReturnType<typeof captureLayout>>,
) {
  diagnostics.register(register, "side-pane", async () => {
    if ((await captureLayout()).sidePaneLabel !== original.sidePaneLabel)
      await $('[data-testid="side-pane-toggle"]').click();
  });
  diagnostics.register(register, "sidebar", async () => {
    if ((await captureLayout()).sidebar !== original.sidebar)
      await $('[data-testid="desktop-top-logo-sidebar-toggle"]').click();
  });
  register("layout-assertion", async () => {
    expect(await captureLayout()).toEqual(original);
  });
}

async function assertSummaryAbsent(parentPaneId: string) {
  const pane = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
  expect(await pane.$(SUMMARY).isExisting()).toBe(false);
  expect(await pane.$('[data-testid="subagent-activity-trigger"]').isExisting()).toBe(false);
}

async function setSidePaneVisible(parentPaneId: string, parentSessionId: string, visible: boolean) {
  if ((await readTask13Facts(parentPaneId, parentSessionId)).layout.sidePane !== visible) {
    await $('[data-testid="side-pane-toggle"]').click();
    await browser.waitUntil(
      async () =>
        (await readTask13Facts(parentPaneId, parentSessionId)).layout.sidePane === visible,
    );
  }
}

async function verifyEndedPresentation(
  parentPaneId: string,
  parentSessionId: string,
  child: ChildIdentity,
) {
  const evidence: unknown[] = [];
  const parent = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
  const facts = await assertEndedOnly(parentPaneId, parentSessionId, 2);
  expect(facts.mode).toBe(ux08Variant);
  if (ux08Variant === "panel") {
    const shell = await parent.$(SUMMARY);
    expect(await shell.isDisplayed()).toBe(true);
    for (const name of ["background", "terminal", "agent", "workflow"]) {
      expect(await shell.getAttribute(`data-running-${name}-count`)).toBe("0");
    }
    // R101：归零由 SessionPane 主动折起 Agent 分区；先真实展开，不能把未挂载目录误判为丢失。
    const agentTriggers = await shell.$$('[data-status-section-trigger="agent"]');
    const availableTriggers = [];
    for (const trigger of agentTriggers) {
      if ((await trigger.isDisplayed()) && (await trigger.isEnabled()))
        availableTriggers.push(trigger);
    }
    expect(availableTriggers).toHaveLength(1);
    const agentTrigger = availableTriggers[0]!;
    if ((await agentTrigger.getAttribute("aria-expanded")) !== "true") await agentTrigger.click();
    await browser.waitUntil(
      async () => (await agentTrigger.getAttribute("aria-expanded")) === "true",
    );
    expect(await agentTrigger.getAttribute("aria-expanded")).toBe("true");
    const buttons = await shell.$$("button");
    const ended = [];
    for (const button of buttons)
      if ((await button.getText()).includes("已结束")) ended.push(button);
    expect(ended).toHaveLength(1);
    expect(await ended[0]!.$("span.ml-auto").getText()).toBe("2");
    evidence.push({
      boundary: "panel-ended-directory",
      facts,
      child: await assertRetainedChild(child, "done", "UX08_RESULT_B"),
    });
    await shell.$('button[aria-label="收起为胶囊"]').click();
    await assertSummaryAbsent(parentPaneId);
    evidence.push({
      boundary: "panel-to-mini",
      facts: await assertEndedOnly(parentPaneId, parentSessionId, 2),
      child: await assertRetainedChild(child, "done", "UX08_RESULT_B"),
    });
  } else {
    await setCurrentElectronRendererContentSize(1280, 800);
    const narrow = await assertEndedOnly(parentPaneId, parentSessionId, 2);
    expect(narrow.conversationWidth).toBeLessThan(1280);
    expect(narrow.conversationWidth).toBeGreaterThan(0);
    await assertSummaryAbsent(parentPaneId);
    evidence.push({
      boundary: "auto-narrow",
      facts: narrow,
      child: await assertRetainedChild(child, "done", "UX08_RESULT_B"),
    });
    await setSidePaneVisible(parentPaneId, parentSessionId, false);
    await setCurrentElectronRendererContentSize(1840, 800);
    const wide = await assertEndedOnly(parentPaneId, parentSessionId, 2);
    expect(wide.conversationWidth).toBeGreaterThanOrEqual(1280);
    await assertSummaryAbsent(parentPaneId);
    // 既有 visibility toggle 不关闭 tab；隐藏时 DOM 中保留的仍是原完整身份。
    expect(
      await browser.execute(
        (id) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")).filter(
            (node) => node.dataset.sidePaneTabId === id,
          ).length,
        child.tabId,
      ),
    ).toBe(1);
    evidence.push({ boundary: "auto-wide-hidden-detail", facts: wide, child });
    await setSidePaneVisible(parentPaneId, parentSessionId, true);
    evidence.push({
      boundary: "auto-restored-detail",
      facts: await assertEndedOnly(parentPaneId, parentSessionId, 2),
      child: await assertRetainedChild(child, "done", "UX08_RESULT_B"),
    });
  }
  await writeEvidence(`task13-${ux08Variant}-ended-presentation.json`, evidence);
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
    const bridge = await browser.execute(() => {
      const current = window as unknown as {
        __zcodeSessionStoreE2E?: { getState?: unknown };
        __zcodeTabStoreE2E?: { getState?: unknown };
        __testActions?: {
          getTheme?: unknown;
          getLocale?: unknown;
          setTheme?: unknown;
          setLocale?: unknown;
        };
      };
      return {
        session: typeof current.__zcodeSessionStoreE2E?.getState === "function",
        tab: typeof current.__zcodeTabStoreE2E?.getState === "function",
        actions: [
          current.__testActions?.getTheme,
          current.__testActions?.getLocale,
          current.__testActions?.setTheme,
          current.__testActions?.setLocale,
        ].every((value) => typeof value === "function"),
      };
    });
    expect(bridge).toEqual({ session: true, tab: true, actions: true });
    const runtime = await browser.electron.execute((electron) => ({
      appPath: electron.app.getAppPath(),
      executable: process.execPath,
      resourcesPath: process.resourcesPath,
    }));
    const expectedApp = join(
      dirname(process.env.ZCODE_E2E_PACKAGED_APP_PATH!),
      "resources",
      "app.asar",
    );
    expect(runtime.appPath.toLowerCase()).toBe(expectedApp.toLowerCase());
    await writeEvidence("task13-compiled-bridge-readiness.json", { bridge, runtime });
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
    const originalLayout = await captureLayout();
    const diagnostics = createTask13Diagnostics("mini");
    await runTask13WithCleanup(
      async (register) => {
        await diagnostics.checkpoint("initial:before", { width: 1840, height: 800 });
        const windowSize = await setCurrentElectronRendererContentSize(1840, 800);
        diagnostics.register(register, "outer-size", () =>
          restoreElectronRendererContentSize(windowSize),
        );
        registerLayoutCleanup(register, diagnostics, originalLayout);
        await diagnostics.checkpoint("initial:after", { width: 1840, height: 800 });
        await sendV4Prompt(
          [
            `${PARENT_MARKER}: launch exactly one Agent with run_in_background true and subagent_type "Explore".`,
            `The child must run Bash command "sleep 30" and then Bash command "sleep 60", one call at a time, then reply with exactly E2E_SUBAGENT_WORK_CARD_CHILD_DONE.`,
            `After the background launch tool returns, reply with exactly ${LAUNCHED} without waiting.`,
          ].join(" "),
        );
        await waitForV4ComposerText("", "工作卡首发后输入框没有清空");
        await waitForV4AssistantMessageContaining(LAUNCHED);
        const parentPaneId = await getV4FocusedPaneId();
        if (!parentPaneId) throw new Error("SAT31 缺少父 pane");
        const parentSessionId = (await getV4PaneSnapshot(parentPaneId)).sessionId;
        if (!parentSessionId || parentSessionId === "draft")
          throw new Error("SAT31 缺少父 session");
        const pane = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
        await writeEvidence(
          "task13-mini-packaged-agent-proof.json",
          await assertCacheRecoveryPackagedAgentProof(process.env.ZCODE_E2E_ARTIFACT_DIR!),
        );

        // SAT31：单个带子会话的派发也渲染为工作卡；后台子智能体可停，"停止全部"出现。
        let state: WorkCardState | null = null;
        try {
          await browser.waitUntil(
            async () => {
              state = await readWorkCardState(parentPaneId);
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
          throw new Error(`SAT31 没有出现运行中的工作卡：${JSON.stringify(state)}`, {
            cause: error,
          });
        }
        expect((await readWorkCardState(parentPaneId)).text).toContain("E2E work card child");
        await selectDisplayMode(parentPaneId, "mini");
        await writeEvidence(
          "task13-mini-running.json",
          await readTask13Facts(parentPaneId, parentSessionId),
        );
        const activity = pane.$('[data-testid="subagent-activity-trigger"]');
        await activity.waitForDisplayed();
        expect(await activity.getAttribute("aria-label")).toContain("运行中");
        const toggle = pane.$('[data-testid^="v4-subagent-work-card-toggle-"]');
        await toggle.click();
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await toggle.getText()).toContain("运行中");
        await activity.waitForDisplayed();
        await toggle.click();
        // MA15：父轮结束后「已工作 N 秒」收起其它工作项，运行中的工作卡仍在折叠摘要之下可见。
        await browser.waitUntil(async () => (await readHistoryOpen(parentPaneId)) === "false", {
          timeout: 30000,
          timeoutMsg: "SAT31 父轮结束后应出现收起的「已工作」摘要",
        });
        expect((await readWorkCardState(parentPaneId)).state).toBe("running");

        // SAT32：点击成员行打开右侧只读子会话；不自动打开。
        const member = await pane.$(`[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`);
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
        const childIdentity = await readChildIdentity(childSessionId);
        const hint = await header
          .$("..")
          .$(`[data-testid="${TID_V4_SUBAGENT_SESSION_READ_ONLY_HINT}"]`);
        await hint.waitForDisplayed({
          timeout: 5000,
          timeoutMsg: "SAT32 右侧没有只读提示",
        });

        const initialRows = await readChildRowCount(childSessionId, childIdentity.tabId);
        await browser.waitUntil(
          async () => (await readChildRowCount(childSessionId, childIdentity.tabId)) > initialRows,
          {
            timeout: 60000,
            timeoutMsg: "SAT32 右侧子会话没有实时增长",
          },
        );
        // 步骤数随子工具调用出现（镜像计步，见规范「引擎无关合同」第 6 条）。
        await browser.waitUntil(
          async () => /\d+ (个步骤|steps?)/u.test((await readWorkCardState(parentPaneId)).text),
          {
            timeout: 60000,
            timeoutMsg: "SAT31 工作卡没有显示步骤数",
          },
        );
        const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
        if (artifactDir) {
          await browser.saveScreenshot(
            join(artifactDir, "subagent-work-card-running-side-pane.png"),
          );
        }

        // SAT33：单个"停止"经父会话 cancelBackgroundWork；停止后卡片与详情头部收口。
        const stop = await pane.$(
          `[data-testid="${TID_V4_SUBAGENT_WORK_CARD_STOP}-${childSessionId}"]`,
        );
        await stop.click();
        await browser.waitUntil(
          async () => (await header.getAttribute("data-status")) === "cancelled",
          {
            timeout: 30000,
            timeoutMsg: "SAT33 详情头部没有变为已停止",
          },
        );
        // UX08：手动打开跨终态保留，外层“已工作”不得吞掉正在看的卡；详情也不关闭。
        await browser.waitUntil(
          async () => (await readWorkCardState(parentPaneId)).state === "ended",
          {
            timeout: 30000,
            timeoutMsg: "SAT34 工作卡没有在全部结束后折叠",
          },
        );
        const ended = await readWorkCardState(parentPaneId);
        expect(ended.stopAll).toBe(0);
        expect(ended.openActions).toBe(1);
        await activity.waitForExist({ reverse: true });
        expect(await header.isDisplayed()).toBe(true);
        expect(await readHistoryOpen(parentPaneId)).toBe("false");
        const endedFacts = await assertEndedOnly(parentPaneId, parentSessionId, 1);
        expect(endedFacts.mode).toBe("mini");
        await assertSummaryAbsent(parentPaneId);
        await writeEvidence("task13-mini-cancelled.json", {
          facts: endedFacts,
          child: await assertRetainedChild(childIdentity, "cancelled"),
        });
        if (artifactDir)
          await browser.saveScreenshot(join(artifactDir, "ux08-cancelled-keeps-detail.png"));
      },
      (outcome, stage) => diagnostics.record(`outer-${stage}`, outcome),
    );
  });

  it("UX08 lifecycle: partial completion → all ended → retained detail → refresh; light/dark, languages, narrow keyboard", async function () {
    this.timeout(TIMEOUT_MS);
    const originalLayout = await captureLayout();
    const diagnostics = createTask13Diagnostics(ux08Variant);
    await runTask13WithCleanup(
      async (register) => {
        await diagnostics.checkpoint("initial:before", { width: 1840, height: 800 });
        const windowSize = await setCurrentElectronRendererContentSize(1840, 800);
        diagnostics.register(register, "outer-size", () =>
          restoreElectronRendererContentSize(windowSize),
        );
        registerLayoutCleanup(register, diagnostics, originalLayout);
        await diagnostics.checkpoint("initial:after", { width: 1840, height: 800 });
        await startNewV4Draft();
        await sendV4Prompt(
          "E2E_UX08_LIFECYCLE: launch two background Explore agents A and B and immediately reply UX08_LAUNCHED.",
        );
        await waitForV4AssistantMessageContaining("UX08_LAUNCHED");
        let parentPaneId = await getV4FocusedPaneId();
        if (!parentPaneId) throw new Error("UX08 缺少 focused parent pane");
        const parentSessionId = (await getV4PaneSnapshot(parentPaneId)).sessionId;
        if (!parentSessionId || parentSessionId === "draft") throw new Error("UX08 缺少父会话");
        let pane = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
        let card = await pane.$('[data-testid^="v4-subagent-work-card-"][data-member-count="2"]');
        await card.waitForDisplayed({ timeout: 60000 });
        await selectDisplayMode(parentPaneId, ux08Variant);
        await writeEvidence(
          `task13-${ux08Variant}-running.json`,
          await readTask13Facts(parentPaneId, parentSessionId),
        );
        await writeEvidence(
          `task13-${ux08Variant}-packaged-agent-proof.json`,
          await assertCacheRecoveryPackagedAgentProof(process.env.ZCODE_E2E_ARTIFACT_DIR!),
        );
        let toggle = await card.$('[data-testid^="v4-subagent-work-card-toggle-"]');
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
        const childIdentity = await readChildIdentity(childSessionId);
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
            liveRows.find(
              (row) => row.parentToolCallId === `toolu_ux08_agent_${label.toLowerCase()}`,
            ),
          ).toMatchObject({ status: "success", summaryText: `UX08 task ${label}` });
        }
        expect((await card.getText()).match(/已完成，可查看过程/gu)).toHaveLength(2);
        expect(await card.getText()).not.toContain("结果：");
        await assertRetainedChild(childIdentity, "done", "UX08_RESULT_B");
        await verifyEndedPresentation(parentPaneId, parentSessionId, childIdentity);
        expect(await readHistoryOpen(parentPaneId)).toBe("false");
        if (artifactDir)
          await browser.saveScreenshot(join(artifactDir, "ux08-success-retained-detail.png"));

        // 原生 Shift+Tab/Enter：从第二成员回到第一成员，不能程序 focus 冒充导航。
        await child.click();
        await browser
          .action("key")
          .down(Key.Shift)
          .down(Key.Tab)
          .up(Key.Tab)
          .up(Key.Shift)
          .perform();
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
        await diagnostics.checkpoint("refresh:before");
        await browser.refresh();
        await diagnostics.checkpoint("refresh:after");
        // 导航与刷新可能重建 tab/pane；按真实父 session 重取唯一可见作用域，不复用旧 locator。
        await browser.waitUntil(async () => (await getV4FocusedPaneId()) !== null, {
          timeout: 30000,
        });
        parentPaneId = await visibleParentPaneId(parentSessionId);
        pane = await $(`[data-testid="v4-session-pane-${parentPaneId}"]`);
        await pane.waitForDisplayed({ timeout: 30000 });
        expect(await pane.$('[data-testid="subagent-activity-trigger"]').isExisting()).toBe(false);
        const history = await pane.$('[data-testid^="chat-assistant-history-trigger-"]');
        await history.click();
        card = await pane.$('[data-testid^="v4-subagent-work-card-"][data-member-count="2"]');
        toggle = await card.$('[data-testid^="v4-subagent-work-card-toggle-"]');
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
        await verifyUx08Appearance(card, artifactDir, diagnostics);
      },
      (outcome, stage) => diagnostics.record(`outer-${stage}`, outcome),
    );
  });
});

async function verifyUx08Appearance(
  card: Awaited<ReturnType<typeof browser.$>>,
  artifactDir?: string,
  diagnostics = createTask13Diagnostics(ux08Variant),
) {
  const preferences = await browser.execute(() => {
    const actions = (window as unknown as { __testActions?: PreferenceActions }).__testActions;
    if (!actions) throw new Error("UX08 缺少原主题/语言 actions");
    return { locale: actions.getLocale(), theme: actions.getTheme() };
  });
  await runTask13WithCleanup(
    async (register) => {
      diagnostics.register(register, "locale", () =>
        browser.execute((original) => {
          const actions = (window as unknown as { __testActions?: PreferenceActions })
            .__testActions;
          if (!actions) throw new Error("UX08 缺少原主题/语言 actions");
          actions.setLocale(original);
        }, preferences.locale),
      );
      diagnostics.register(register, "theme", () =>
        browser.execute((original) => {
          const actions = (window as unknown as { __testActions?: PreferenceActions })
            .__testActions;
          if (!actions) throw new Error("UX08 缺少原主题/语言 actions");
          actions.setTheme(original);
        }, preferences.theme),
      );
      await diagnostics.checkpoint("appearance:initial:before", { width: 1280, height: 800 });
      const previous = await setCurrentElectronRendererContentSize(1280, 800);
      let minimum: number[] | undefined;
      diagnostics.register(register, "minimum", async () => {
        if (minimum)
          await browser.electron.execute(
            (electron, id, min) =>
              electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
            previous.windowId,
            minimum,
          );
      });
      diagnostics.register(register, "appearance-size", () =>
        restoreElectronRendererContentSize(previous),
      );
      // 先取得原min快照再设置，设置本身失败时也能执行已登记的恢复。
      minimum = await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)!.getMinimumSize(),
        previous.windowId,
      );
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)!.setMinimumSize(320, 400),
        previous.windowId,
      );
      await diagnostics.checkpoint("appearance:initial:after", { width: 1280, height: 800 });
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
        await diagnostics.checkpoint(`appearance:${width}:before`, { width, height: 800 });
        await setCurrentElectronRendererContentSize(width, 800);
        await diagnostics.checkpoint(`appearance:${width}:after`, { width, height: 800 });
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
    },
    (outcome, stage) => diagnostics.record(`appearance-${stage}`, outcome),
  );
}
