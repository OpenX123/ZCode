// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { LocalUsageRequest } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LocalUsagePanel } from "@/settings/usage-stats/local/LocalUsagePanel.js";
import { draftToModelPrice } from "@/settings/usage-stats/local/LocalUsagePricingTab.js";
import {
  formatCostUsd,
  mapToAppUsageRange,
} from "@/settings/usage-stats/local/localUsageFormat.js";
import { createLocalUsageSnapshot } from "./fixtures/localUsageSnapshot.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createServices() {
  const getLocalUsageSnapshot = vi.fn(async (request: LocalUsageRequest) =>
    createLocalUsageSnapshot({ source: request.source, range: request.range }),
  );
  const getAppUsageSnapshot = vi.fn(async () => {
    throw new Error("no_active_workspace");
  });
  const services = {
    usageStatsService: {
      getLocalUsageSnapshot,
      getAppUsageSnapshot,
      setModelPriceOverride: vi.fn(async () => undefined),
      syncModelPrices: vi.fn(async () => ({ syncedAt: 1, modelCount: 2 })),
    },
  } as unknown as IServiceAccessor;
  return { services, getLocalUsageSnapshot, getAppUsageSnapshot };
}

function renderPanel(services: IServiceAccessor) {
  return render(
    createElement(
      ServiceProvider,
      { services },
      createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, createElement(LocalUsagePanel)),
    ),
  );
}

describe("LocalUsagePanel（LU-11）", () => {
  it("展示来源/范围、四张卡片、53 周热力图与按模型明细，标注按 API 价格估算", async () => {
    await import("@/settings/usage-stats/local/LocalUsageTrendChart.js");
    const { services, getLocalUsageSnapshot } = createServices();
    renderPanel(services);
    await screen.findByText("请求数");
    expect(getLocalUsageSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ source: "all", range: "7d" }),
    );
    for (const label of [
      "全部",
      "YCode",
      "Claude Code",
      "Codex",
      "今天",
      "7 天",
      "30 天",
      "自定义",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("请求数")).toBeTruthy();
    expect(screen.getByText("缓存命中率")).toBeTruthy();
    expect(screen.getAllByText("按 API 价格估算").length).toBeGreaterThan(0);
    expect(screen.getByText("Token 活动")).toBeTruthy();
    expect(screen.getByText("synthetic-sonnet")).toBeTruthy();
    expect(screen.getByTestId("zcode-runtime-metrics")).toBeTruthy();
  });

  it("切换到 Claude Code 时隐藏 YCode 运行指标并按来源重新请求", async () => {
    const { services, getLocalUsageSnapshot } = createServices();
    renderPanel(services);
    await screen.findByText("请求数");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    await waitFor(() =>
      expect(getLocalUsageSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ source: "claude-code" }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("zcode-runtime-metrics")).toBeNull());
  });

  it("请求明细显示来源标签", async () => {
    const { services } = createServices();
    renderPanel(services);
    await screen.findByText("请求数");
    const tab = screen.getByRole("tab", { name: "请求明细" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByText("YCode · Claude Code")).toBeTruthy();
  });
});

describe("本机用量格式化", () => {
  it("费用极小值显示 <$0.01，范围映射到 agent-db 窗口", () => {
    expect(formatCostUsd("en-US", 0.001)).toBe("<$0.01");
    expect(formatCostUsd("en-US", 12.345)).toBe("$12.35");
    expect(formatCostUsd("en-US", null)).toBe("--");
    expect(mapToAppUsageRange("today")).toBe("7d");
    expect(mapToAppUsageRange("30d")).toBe("30d");
    expect(mapToAppUsageRange("custom")).toBe("all");
  });

  it("价格草稿校验：必填 input/output，1h 可选，负数非法", () => {
    expect(
      draftToModelPrice({
        input: "3",
        output: "15",
        cacheRead: "",
        cacheWrite: "",
        cacheWrite1h: "",
      }),
    ).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
    expect(
      draftToModelPrice({
        input: "",
        output: "15",
        cacheRead: "",
        cacheWrite: "",
        cacheWrite1h: "",
      }),
    ).toBeNull();
    expect(
      draftToModelPrice({
        input: "1",
        output: "1",
        cacheRead: "-1",
        cacheWrite: "",
        cacheWrite1h: "",
      }),
    ).toBeNull();
  });
});
