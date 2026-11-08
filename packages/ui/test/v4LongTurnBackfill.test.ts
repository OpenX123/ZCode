// @vitest-environment jsdom
// HLP01 长单轮回填性能回归（docs/ui/chat-virtual-scroll.md「长轮历史回填」）。
//
// 现场：打开数千行的单轮会话后，冷快照尾窗缺 turnHeader，补页间隔随已加载行数线性增长
// （Host 每页 3–7ms，Renderer 页间隔 0.06s → 2.4s）。这里用真实 ProjectionStore 与真实
// ConversationTimeline 驱动整段补齐，触发 effect 与 SessionPane 同构；以「行渲染总数」和
// 「尾窗已挂载行是否被替换」作为与机器速度无关的确定性指标。
import { createElement, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import {
  ConversationProjectionStore,
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";

const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/v4/ConversationTurnRow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/ConversationTurnRow.js")>();
  const React = await import("react");
  return {
    ...actual,
    ConversationTurnRow: (props: Parameters<typeof actual.ConversationTurnRow>[0]) => {
      rowRenders.count += 1;
      return React.createElement(actual.ConversationTurnRow, props);
    },
  };
});

const TOTAL_ROWS = 720;
const TAIL_ROWS = 60;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
  // jsdom 没有布局；给滚动容器一个视口尺寸，virtualizer 才会像真实窗口一样挂载唯一的长轮。
  for (const [name, value] of [
    ["offsetHeight", 800],
    ["offsetWidth", 1000],
    ["clientHeight", 800],
    ["clientWidth", 1000],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});

let mountedRoot: Root | null = null;
afterEach(() => {
  mountedRoot?.unmount();
  mountedRoot = null;
  document.body.innerHTML = "";
  rowRenders.count = 0;
});

/**
 * 用户中断的长任务：单轮、header 在最前，正文与 Bash 交替（不形成工具分组），
 * 中断态强制展开历史区，整轮行常驻 DOM——与现场 600MB heap 的展开态一致。
 */
function longInterruptedTurnRows(total: number): ConversationRow[] {
  const base = (rowId: number) => ({ rowId, turnId: "t1", createdAt: 1, createdAtSeq: rowId });
  const rows: ConversationRow[] = [
    {
      ...base(1),
      kind: "turnHeader",
      origin: "userInput",
      state: "completedInterrupted",
      startedAt: 1,
      endedAt: 2,
      activeMs: 1,
    },
    { ...base(2), kind: "userInput", origin: "realUser", text: "长任务" },
  ];
  for (let rowId = 3; rowId <= total; rowId += 1) {
    rows.push(
      rowId % 2 === 1
        ? { ...base(rowId), kind: "assistantText", text: `进展 ${rowId}`, state: "complete" }
        : {
            ...base(rowId),
            kind: "toolCall",
            toolCallId: `call-${rowId}`,
            toolName: "Bash",
            status: "success",
            inputText: `{"command":"echo ${rowId}"}`,
            input: { command: `echo ${rowId}` },
          },
    );
  }
  return rows;
}

function snapshotOf(all: readonly ConversationRow[]): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s1",
    logEpoch: "epoch-1",
    seq: 5,
    revision: 0,
    control: {
      phase: "completedInterrupted",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "idleCannotCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: { window: all.slice(-TAIL_ROWS), totalCount: all.length, firstRowId: 1 },
  };
}

function createTransport(all: readonly ConversationRow[]) {
  const frameListeners = new Set<(frame: ConversationTopicFrame) => void>();
  const pendingInitial = new Map<string, ConversationTopicFrame>();
  const rowsRangeCalls: V4ConversationRowsRangeParams[] = [];
  // 首个 rowsRange 等测试记录完尾窗首帧后再放行；fake 应答本身是同步的，不放闸会在
  // 一串微任务里跑完整段补齐，测试无从区分补齐前后的 DOM 与渲染计数。
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const transport = {
    onFrame(listener: (frame: ConversationTopicFrame) => void) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    async subscribe() {
      const subscriptionId = "sub-1";
      pendingInitial.set(subscriptionId, {
        topic: "conversation/s1",
        subscriptionId,
        fromSeq: 0,
        toSeq: 5,
        sentAt: 1,
        payload: { kind: "snapshot", snapshot: snapshotOf(all) },
      });
      return { ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "epoch-1" } };
    },
    activate(subscriptionId: string) {
      const frame = pendingInitial.get(subscriptionId);
      pendingInitial.delete(subscriptionId);
      if (frame) for (const listener of frameListeners) listener(frame);
    },
    async unsubscribe() {},
    async plans() {
      return { plans: [], atSeq: 5, atLogEpoch: "epoch-1" };
    },
    async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      rowsRangeCalls.push(params);
      await gate;
      const end = (params.beforeRowId ?? all.length + 1) - 1;
      const start = Math.max(1, end - params.limit + 1);
      return {
        rows: all.slice(start - 1, end),
        atSeq: 5,
        atRevision: 0,
        atLogEpoch: "epoch-1",
        hasMore: start > 1,
      };
    },
  };
  return {
    transport: transport as unknown as ConversationTransport & {
      onFrame: typeof transport.onFrame;
    },
    rowsRangeCalls,
    openGate,
  };
}

/**
 * 与 SessionPane 相同的接线：store 订阅 + HLP01 触发 effect + ConversationTimeline。
 * effect 逐字对应 SessionPane「冷快照首 turn 不完整，自动补拉更早行」：同一判定、同一游标去重、
 * 同一 store 入口；SessionPane 依赖面过大，无法在单测里整体挂载。
 */
function Harness({ store }: { store: ConversationProjectionStore }) {
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
  );
  const snapshot = state.snapshot;
  const cursorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)) return;
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `s1:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (cursorRef.current === cursorKey) return;
    cursorRef.current = cursorKey;
    void store.loadIncompleteLeadingTurn();
  }, [snapshot, state.loadingOlder, state.subscriptionId, store]);
  const rowContext = useMemo(
    () => ({
      workspacePath: "/fixture",
      sessionId: "s1",
      theme: "dark" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [],
  );
  return createElement(
    TooltipProvider,
    null,
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(ConversationTimeline, {
        rows: snapshot?.rows.window ?? [],
        totalCount: snapshot?.rows.totalCount ?? 0,
        sessionKey: "s1",
        rowContext,
        canLoadOlder: snapshot ? hasOlderRows(snapshot) : false,
        loadingOlder: state.loadingOlder,
        onLoadOlder: () => store.loadOlder(),
        sessionPhase: snapshot?.control.phase,
        hideTurnNavigator: true,
      }),
    }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("HLP01 长单轮回填", () => {
  it("补齐整轮只渲染一次已加载行，且不重挂尾窗原有行", async () => {
    const all = longInterruptedTurnRows(TOTAL_ROWS);
    const { transport, rowsRangeCalls, openGate } = createTransport(all);
    const store = new ConversationProjectionStore("conversation/s1", transport);
    transport.onFrame((frame) => store.handleFrame(frame));
    const windowCommits: number[] = [];
    store.subscribe(() => {
      const length = store.getState().snapshot?.rows.window.length;
      if (length !== undefined && length !== windowCommits.at(-1)) windowCommits.push(length);
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    mountedRoot = createRoot(host);
    mountedRoot.render(createElement(Harness, { store }));
    await store.connect();

    // 尾窗首帧：首行属于中断轮中部，header/user 尚在更早页。
    const tailRowId = TOTAL_ROWS - 1;
    await waitFor(
      () =>
        rowsRangeCalls.length === 1 && host.querySelector(`[data-row-id="${tailRowId}"]`) !== null,
    );
    const tailRowElement = host.querySelector(`[data-row-id="${tailRowId}"]`);
    const rowRendersBeforeBackfill = rowRenders.count;
    expect(windowCommits).toEqual([TAIL_ROWS]);
    openGate();

    await waitFor(
      () =>
        !store.getState().loadingOlder &&
        !shouldAutoLoadIncompleteLeadingTurn(store.getState().snapshot, false),
    );
    await waitFor(() => host.querySelector('[data-row-id="2"]') !== null);

    const window = store.getState().snapshot?.rows.window ?? [];
    // 展示语义不变：整轮补齐、无重复、header 与用户 query 可见。
    expect(window.map((row) => row.rowId)).toEqual(all.map((row) => row.rowId));
    expect(window[0]?.kind).toBe("turnHeader");
    expect(windowCommits.at(-1)).toBe(TOTAL_ROWS);
    expect(windowCommits).toEqual([...windowCommits].sort((a, b) => a - b));

    // 根因 1：逐页提交让每页都重渲染整轮已加载行（总量 ≈ N²/120）。补齐只允许一次整轮渲染。
    const backfillRowRenders = rowRenders.count - rowRendersBeforeBackfill;
    expect
      .soft({
        backfillRowRenders,
        commits: windowCommits.length,
        rowsRangeCalls: rowsRangeCalls.length,
      })
      .toMatchObject({ commits: 2 });
    expect.soft(backfillRowRenders).toBeLessThanOrEqual(2 * TOTAL_ROWS);

    // 根因 2：段首 history item 以首行 rowId 作 key，前插后整段卸载重挂。尾窗行必须是同一 DOM。
    expect.soft(host.querySelector(`[data-row-id="${tailRowId}"]`)).toBe(tailRowElement);
  }, 120_000);
});
