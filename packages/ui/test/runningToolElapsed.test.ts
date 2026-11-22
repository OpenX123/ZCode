// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnActivityState } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { RunningToolActivityProvider } from "@/turn-stall/index.js";

// docs/chat/turn-stall-indicator.md「工具行耗时」：running_tool 不再出独立提示条，
// 而是在 turnActivity 命中的运行中工具行尾追加耗时。
const T0 = 1_700_000_000_000;

function runningTool(toolCallId = "call-1"): TurnActivityState {
  return {
    turnId: "turn-1",
    lastActivityAt: T0,
    phaseStartedAt: T0,
    activityPhase: { kind: "running_tool", toolName: "Bash", toolCallId },
  };
}

function row(toolId: string, props: Partial<Parameters<typeof ToolLayout>[0]> = {}) {
  return createElement(ToolLayout, {
    key: toolId,
    toolId,
    icon: null,
    kindLabel: "正在执行",
    primaryText: `cmd ${toolId}`,
    isRunning: true,
    ...props,
  });
}

function tree(
  children: ReactNode,
  providerProps: Partial<Parameters<typeof RunningToolActivityProvider>[0]> = {},
) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(RunningToolActivityProvider, {
      turnActivity: runningTool(),
      running: true,
      hasPendingInteraction: false,
      ...providerProps,
      children,
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("运行中工具行耗时", () => {
  it("59s 不显示，越过 60s 后在命中行尾显示「1 分钟」，非命中行与已完成行不显示", () => {
    vi.setSystemTime(T0 + 59_000);
    render(tree([row("call-1"), row("call-2"), row("call-done", { isRunning: false })]));
    expect(screen.queryByTestId("tool-running-elapsed")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    const elapsed = screen.getAllByTestId("tool-running-elapsed");
    expect(elapsed).toHaveLength(1);
    expect(elapsed[0]!.textContent).toBe("·1 分钟");
    act(() => {
      vi.setSystemTime(T0 + 3 * 60_000);
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId("tool-running-elapsed").textContent).toBe("·3 分钟");
  });

  it("分组行按子工具 id 命中", () => {
    vi.setSystemTime(T0 + 2 * 60_000);
    render(tree(row("execute:call-0", { activityToolCallIds: ["call-0", "call-1"] })));
    expect(screen.getByTestId("tool-running-elapsed").textContent).toBe("·2 分钟");
  });

  it("有待处理交互、只读、轮次结束或无 provider 时不显示", () => {
    vi.setSystemTime(T0 + 10 * 60_000);
    const view = render(tree(row("call-1"), { hasPendingInteraction: true }));
    expect(screen.queryByTestId("tool-running-elapsed")).toBeNull();
    view.rerender(tree(row("call-1"), { disabled: true }));
    expect(screen.queryByTestId("tool-running-elapsed")).toBeNull();
    view.rerender(tree(row("call-1"), { running: false }));
    expect(screen.queryByTestId("tool-running-elapsed")).toBeNull();
    view.rerender(tree(row("call-1")));
    expect(screen.getByTestId("tool-running-elapsed").textContent).toBe("·10 分钟");
    view.rerender(
      createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children: row("call-1") }),
    );
    expect(screen.queryByTestId("tool-running-elapsed")).toBeNull();
  });

  it("当前运行工具切换后耗时从新工具的阶段起点重新计算", () => {
    vi.setSystemTime(T0 + 5 * 60_000);
    const view = render(tree([row("call-1"), row("call-2")]));
    expect(screen.getByTestId("tool-running-elapsed").textContent).toBe("·5 分钟");
    view.rerender(
      tree([row("call-1"), row("call-2")], {
        turnActivity: { ...runningTool("call-2"), phaseStartedAt: T0 + 4 * 60_000 },
      }),
    );
    const elapsed = screen.getAllByTestId("tool-running-elapsed");
    expect(elapsed).toHaveLength(1);
    expect(elapsed[0]!.textContent).toBe("·1 分钟");
  });
});
