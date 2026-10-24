// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChatContextUsage,
  buildContextUsageBreakdownSegments,
  formatContextCacheHitRateLabel,
  formatContextUsageSummary,
  formatContextUsageTokenCount,
} from "@/chat-input-toolbar/contextUsage.js";
vi.mock("@/components/ai-elements/context.js", async () => {
  const { createElement } = await import("react");
  return {
    Context: ({ children }: { children: unknown }) => createElement("div", null, children),
    ContextContentBody: ({ children }: { children: unknown }) =>
      createElement("div", null, children),
    ContextContent: ({ children }: { children: unknown }) => createElement("div", null, children),
    ContextTrigger: (props: object) => createElement("button", props),
  };
});

describe("buildContextUsageBreakdownSegments", () => {
  it("aggregates valid chars by source and sorts largest first", () => {
    expect(
      buildContextUsageBreakdownSegments([
        { source: "messages", chars: 700 },
        { source: "system_tool_schemas", chars: 200 },
        { source: "messages", chars: 100 },
        { source: "skills", chars: 0 },
      ]),
    ).toEqual([
      { source: "messages", chars: 800, percent: 0.8 },
      { source: "system_tool_schemas", chars: 200, percent: 0.2 },
    ]);
  });

  it("returns an empty list when no positive chars are available", () => {
    expect(
      buildContextUsageBreakdownSegments([
        { source: "messages", chars: 0 },
        { source: "skills", chars: -1 },
      ]),
    ).toEqual([]);
  });
});

describe("formatContextUsageTokenCount", () => {
  it("uses uppercase compact suffixes for English context usage", () => {
    expect(formatContextUsageTokenCount(399_900, "en-US")).toBe("399.9K");
    expect(formatContextUsageTokenCount(200_000, "en-US")).toBe("200K");
    expect(formatContextUsageTokenCount(1_250_000, "en-US")).toBe("1.3M");
  });

  it("uses localized compact units for Chinese context usage", () => {
    expect(formatContextUsageTokenCount(399_900, "zh-CN")).toBe("40万");
    expect(formatContextUsageTokenCount(200_000, "zh-CN")).toBe("20万");
    expect(formatContextUsageTokenCount(120_000_000, "zh-CN")).toBe("1.2亿");
  });
});

describe("formatContextUsageSummary", () => {
  it("combines compact token values and usage percentage", () => {
    expect(
      formatContextUsageSummary({
        locale: "en-US",
        percent: 1,
        size: 200_000,
        used: 399_900,
      }),
    ).toBe("399.9K/200K (100%)");
  });
});

describe("formatContextCacheHitRateLabel", () => {
  it("keeps the production threshold for low cache hit rates", () => {
    expect(formatContextCacheHitRateLabel(0.048, "en-US")).toBeNull();
  });

  it("formats low cache hit rates when development diagnostics are enabled", () => {
    expect(
      formatContextCacheHitRateLabel(0.048, "en-US", {
        showBelowThreshold: true,
      }),
    ).toBe("4.8%");
  });

  it("does not invent a cache hit rate when the provider omits it", () => {
    expect(
      formatContextCacheHitRateLabel(null, "en-US", {
        showBelowThreshold: true,
      }),
    ).toBeNull();
  });
});

describe("ChatContextUsage", () => {
  it("does not render derived zero-usage capacity without task usage or plan data", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        ...({
          contextCapacityTokens: 1_000_000,
        } as Partial<ComponentProps<typeof ChatContextUsage>>),
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: null,
      }),
    );

    expect(html).not.toContain("chat.contextUsage.title");
    expect(html).not.toContain("0/1M (0%)");
  });

  it("renders cache hit rate when the context usage reaches the display threshold", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: {
          used: 17_000,
          size: 1_000_000,
          cache: { hitRate: 0.8 },
        },
      }),
    );

    expect(html).toContain("chat.contextUsage.cacheHitRate");
    expect(html).toContain("80%");
  });

  it("renders a low cache hit rate in the development environment", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: {
          used: 17_000,
          size: 1_000_000,
          cache: { hitRate: 0.048 },
        },
      }),
    );

    expect(import.meta.env.DEV).toBe(true);
    expect(html).toContain("chat.contextUsage.cacheHitRate");
    expect(html).toContain("4.8%");
  });

  it("does not render per-source token counts in the breakdown rows", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: {
          used: 17_000,
          size: 1_000_000,
          breakdown: [
            { source: "system_tool_schemas", chars: 52_000 },
            { source: "messages", chars: 38_000 },
          ],
        },
      }),
    );

    expect(html).toContain("chat.contextUsage.breakdown.systemTools");
    expect(html).toContain("chat.contextUsage.breakdown.messages");
    expect(html).toContain("57.8%");
    expect(html).toContain("42.2%");
    expect(html).not.toContain("52K");
    expect(html).not.toContain("38K");
  });
});
