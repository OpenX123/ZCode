import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnActivityState } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationStallNotice, resolveConversationStallState } from "@/turn-stall/index.js";

const T0 = 1_700_000_000_000;

function activity(overrides: Partial<TurnActivityState> = {}): TurnActivityState {
  return {
    turnId: "turn-1",
    lastActivityAt: T0,
    phaseStartedAt: T0,
    activityPhase: { kind: "waiting_model" },
    ...overrides,
  };
}

function state(
  nowMs: number,
  overrides: Partial<Parameters<typeof resolveConversationStallState>[0]> = {},
) {
  return resolveConversationStallState({
    turnActivity: activity(),
    running: true,
    hasPendingInteraction: false,
    nowMs,
    ...overrides,
  });
}

function renderNotice(nowMs: number, props: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationStallNotice, {
        turnActivity: activity(),
        running: true,
        hasPendingInteraction: false,
        engineLabel: "Claude Code",
        onInterrupt: vi.fn(),
        onInterruptAndRetry: vi.fn(),
        onViewLogs: vi.fn(),
        ...props,
      }),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveConversationStallState", () => {
  it("does not show anything before 60s of silence", () => {
    expect(state(T0 + 59_999)).toEqual({ kind: "none" });
  });

  it("shows a hint at 60s and a warning at 5 minutes", () => {
    expect(state(T0 + 60_000)).toEqual({ kind: "idle", level: "hint", idleMinutes: 1 });
    expect(state(T0 + 5 * 60_000)).toEqual({ kind: "idle", level: "warning", idleMinutes: 5 });
  });

  it("treats running tools as progress, never as a warning", () => {
    const tool = activity({
      phaseStartedAt: T0,
      lastActivityAt: T0,
      activityPhase: { kind: "running_tool", toolName: "Bash" },
    });
    expect(state(T0 + 30_000, { turnActivity: tool })).toEqual({ kind: "none" });
    expect(state(T0 + 20 * 60_000, { turnActivity: tool })).toEqual({
      kind: "tool",
      toolName: "Bash",
      elapsedMinutes: 20,
    });
  });

  it("stays hidden while waiting for the user or after the turn ends", () => {
    expect(state(T0 + 10 * 60_000, { hasPendingInteraction: true })).toEqual({ kind: "none" });
    expect(state(T0 + 10 * 60_000, { running: false })).toEqual({ kind: "none" });
    expect(state(T0 + 10 * 60_000, { turnActivity: null })).toEqual({ kind: "none" });
  });
});

describe("ConversationStallNotice", () => {
  it("renders the hint without actions", () => {
    const html = renderNotice(T0 + 2 * 60_000);
    expect(html).toContain('data-stall-kind="hint"');
    expect(html).toContain("Claude Code 已 2 分钟无输出 · 等待模型响应");
    expect(html).not.toContain("中断并重试");
  });

  it("renders the warning with interrupt-and-retry, interrupt and logs", () => {
    const html = renderNotice(T0 + 6 * 60_000);
    expect(html).toContain('data-stall-kind="warning"');
    expect(html).toContain("中断并重试");
    expect(html).toContain("中断");
    expect(html).toContain("查看日志");
  });

  it("hides optional actions when the host cannot provide them", () => {
    const html = renderNotice(T0 + 6 * 60_000, {
      onInterruptAndRetry: undefined,
      onViewLogs: undefined,
    });
    expect(html).not.toContain("中断并重试");
    expect(html).not.toContain("查看日志");
  });

  it("renders running tool progress copy", () => {
    const html = renderNotice(T0 + 3 * 60_000, {
      turnActivity: activity({ activityPhase: { kind: "running_tool", toolName: "Bash" } }),
    });
    expect(html).toContain("正在执行 Bash，已 3 分钟");
  });
});
