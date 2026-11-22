// @vitest-environment jsdom
// docs/chat/turn-stall-indicator.md「对齐」：live tail footer（无响应提示条）与轮内容同一左边线。
// 1.5.0 footer 只有 pb-2，拿不到 ConversationTurnGroup <section> 上的水平内边距，提示条贴在内容列最左。
import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { TURN_CONTENT_INLINE_PADDING_CLASS } from "@/v4/ConversationTurnGroup.js";

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

function Harness() {
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
        liveTailFooter: createElement("div", { "data-testid": "stall-notice" }, "notice"),
      } as Parameters<typeof ConversationTimeline>[0]),
    }),
  );
}

describe("ConversationTimeline live tail footer", () => {
  it("footer 与轮内容 section 使用同一水平内边距", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Harness)));

    const liveTail = host.querySelector('[data-v4-running-live-tail="true"]');
    const footer = liveTail?.querySelector('[data-v4-live-tail-footer="true"]');
    const section = liveTail?.querySelector("section[data-turn-id]");
    expect(footer?.querySelector('[data-testid="stall-notice"]')).not.toBeNull();
    for (const token of TURN_CONTENT_INLINE_PADDING_CLASS.split(" ")) {
      expect(footer?.classList.contains(token)).toBe(true);
      expect(section?.classList.contains(token)).toBe(true);
    }
  });
});
