// @vitest-environment jsdom
// docs/desktop/engine-performance-1.1-spec.md「隐藏面板暂停渲染」HP03：
// 运行中轮次的“工作中 N 秒”计时器每秒推进 liveNowMs，触发 render unit 重算；面板隐藏时必须停下，
// 重新可见时立即以当前时间重算一次。以 render unit 选择器的调用次数作为与机器速度无关的计数。
import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

const selectorCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/v4/conversationTurnRenderUnits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/conversationTurnRenderUnits.js")>();
  return {
    ...actual,
    createConversationTurnRenderUnitsSelector: () => {
      const select = actual.createConversationTurnRenderUnitsSelector();
      return (...args: Parameters<typeof select>) => {
        selectorCalls.count += 1;
        return select(...args);
      };
    },
  };
});

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  selectorCalls.count = 0;
  vi.useRealTimers();
});

const RUNNING_ROWS: ConversationRow[] = [
  {
    rowId: 1,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "running",
    startedAt: 1,
  },
  {
    rowId: 2,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: 2,
    kind: "userInput",
    origin: "realUser",
    text: "开始",
  },
] as ConversationRow[];

function Harness({ paused }: { paused: boolean }) {
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
        rows: RUNNING_ROWS,
        totalCount: RUNNING_ROWS.length,
        sessionKey: "s1",
        rowContext,
        sessionPhase: "running",
        hideTurnNavigator: true,
        paused,
      } as Parameters<typeof ConversationTimeline>[0]),
    }),
  );
}

describe("ConversationTimeline 隐藏时暂停运行计时器", () => {
  it("HP03：隐藏期间不按秒重算 render unit，可见后立即重算", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    // act 会把同一作用域内的更新合并成一次渲染；逐秒推进才能数出每一次计时重算。
    const advanceSeconds = async (seconds: number) => {
      for (let second = 0; second < seconds; second += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
    };

    act(() => root!.render(createElement(Harness, { paused: false })));
    const afterMount = selectorCalls.count;
    await advanceSeconds(3);
    // 可见：每秒一次重算（基线，证明计时器在跑）。
    expect(selectorCalls.count - afterMount).toBeGreaterThanOrEqual(3);

    act(() => root!.render(createElement(Harness, { paused: true })));
    const afterHide = selectorCalls.count;
    await advanceSeconds(5);
    // 修复前：隐藏期间仍每秒重算（5 次）。
    expect(selectorCalls.count - afterHide).toBe(0);

    act(() => root!.render(createElement(Harness, { paused: false })));
    // 可见后立即以当前时间重算，不等下一个整秒。
    expect(selectorCalls.count).toBeGreaterThan(afterHide);
    const afterShow = selectorCalls.count;
    await advanceSeconds(2);
    expect(selectorCalls.count - afterShow).toBeGreaterThanOrEqual(2);
  });
});
