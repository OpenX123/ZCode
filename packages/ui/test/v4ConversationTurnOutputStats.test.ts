// @vitest-environment jsdom

import { act, createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  ConversationAssistantTextActions,
  formatTurnOutputStatsLabel,
  resolveTurnOutputStats,
  type TurnOutputStats,
} from "@/v4/ConversationRowView.js";

function intlFor(messages: Record<string, string>): IntlInstance {
  return {
    formatMessage({ id }, values) {
      let text = messages[id] ?? id;
      for (const [key, value] of Object.entries(values ?? {})) {
        text = text.replaceAll(`{${key}}`, String(value));
      }
      return text;
    },
  };
}

const zhIntl = intlFor(zhCN as Record<string, string>);
const enIntl = intlFor(enUS as Record<string, string>);

const nativeStats: TurnOutputStats = {
  outputTps: 48.23,
  outputTokens: 1234,
  firstTokenMs: 1100,
  activeMs: 23_000,
};

afterEach(() => {
  cleanup();
});

describe("formatTurnOutputStatsLabel", () => {
  it("原生引擎显示 tokens/s、输出、首字与总耗时", () => {
    expect(formatTurnOutputStatsLabel(nativeStats, zhIntl, "zh-CN")).toBe(
      "48.2 tokens/s · 输出 1,234 tokens · 首字 1.1 秒 · 总耗时 23 秒",
    );
    expect(formatTurnOutputStatsLabel(nativeStats, enIntl, "en-US")).toBe(
      "48.2 tokens/s · Output 1,234 tokens · First token 1.1s · Total 23s",
    );
  });

  it("外部引擎没有 tokens/s，Codex 附带思考 tokens", () => {
    expect(
      formatTurnOutputStatsLabel(
        { outputTokens: 1234, reasoningTokens: 300, activeMs: 23_000 },
        zhIntl,
        "zh-CN",
      ),
    ).toBe("输出 1,234 tokens（含思考 300）· 总耗时 23 秒");
    expect(
      formatTurnOutputStatsLabel(
        { outputTokens: 1234, reasoningTokens: 300, activeMs: 23_000 },
        enIntl,
        "en-US",
      ),
    ).toBe("Output 1,234 tokens (incl. 300 thinking) · Total 23s");
  });

  it("没有任何数据时不生成提示", () => {
    expect(formatTurnOutputStatsLabel({}, zhIntl, "zh-CN")).toBeNull();
  });
});

describe("resolveTurnOutputStats", () => {
  const header = {
    state: "completedSuccess" as const,
    outputTps: 10,
    outputTokens: 100,
    reasoningTokens: 0,
    firstTokenMs: 500,
    activeMs: 4000,
  };

  it("只对已完成轮次给出统计", () => {
    expect(resolveTurnOutputStats(header)).toEqual({
      outputTps: 10,
      outputTokens: 100,
      reasoningTokens: 0,
      firstTokenMs: 500,
      activeMs: 4000,
    });
    expect(resolveTurnOutputStats({ ...header, state: "completedInterrupted" })).not.toBeNull();
    expect(resolveTurnOutputStats({ ...header, state: "running" })).toBeNull();
    expect(resolveTurnOutputStats({ ...header, state: "failed" })).toBeNull();
    expect(resolveTurnOutputStats(undefined)).toBeNull();
  });
});

function renderActions(
  stats: TurnOutputStats | undefined,
  state: "completedSuccess" | "running" = "completedSuccess",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(ConversationAssistantTextActions, {
          rowId: 7,
          text: "reply",
          createdAt: Date.now(),
          turnHeader: stats ? { state, ...stats } : undefined,
        }),
      ),
    ),
  );
}

describe("ConversationAssistantTextActions 输出统计提示", () => {
  it("时间元素可键盘聚焦，聚焦后显示原生统计提示", async () => {
    renderActions(nativeStats);
    const time = document.querySelector<HTMLElement>("[data-v4-turn-output-stats]");
    expect(time).not.toBeNull();
    expect(time!.tabIndex).toBe(0);
    const describedBy = time!.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "48.2 tokens/s · 输出 1,234 tokens · 首字 1.1 秒 · 总耗时 23 秒",
    );
    await act(async () => {
      time!.focus();
    });
    expect((await screen.findByRole("tooltip")).textContent).toContain("48.2 tokens/s");
  });

  it("外部引擎提示不含 tokens/s", () => {
    renderActions({ outputTokens: 1234, reasoningTokens: 300, activeMs: 23_000 });
    const time = document.querySelector<HTMLElement>("[data-v4-turn-output-stats]");
    const text = document.getElementById(time!.getAttribute("aria-describedby")!)?.textContent;
    expect(text).toBe("输出 1,234 tokens（含思考 300）· 总耗时 23 秒");
    expect(text).not.toContain("tokens/s");
  });

  it("没有统计或轮次未完成时时间元素保持原样，不可聚焦", () => {
    renderActions(undefined);
    expect(document.querySelector("[data-v4-turn-output-stats]")).toBeNull();
    cleanup();
    renderActions(nativeStats, "running");
    expect(document.querySelector("[data-v4-turn-output-stats]")).toBeNull();
  });
});
