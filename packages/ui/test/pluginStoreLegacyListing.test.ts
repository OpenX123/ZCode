import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// 与 pluginStoreInstalledStripTooltip.test.ts 同款：ControlHintTooltip 依赖 Root 的
// TooltipProvider，SSR 单测里桩成透传 span，把 title 落到属性上便于断言 hover 文案。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

// 旧目录可能仍携带商业展示字段，独立桌面忽略它并保留普通插件操作。
function makeItem(requiresPaidPlan: boolean | undefined): StorePluginItem {
  return {
    id: "pro-plugin@zcode-plugins-official",
    name: "pro-plugin",
    marketplace: "zcode-plugins-official",
    installed: false,
    restorable: false,
    orphaned: false,
    listing: {
      displayName: "Pro Plugin",
      ...(requiresPaidPlan === undefined ? {} : { requiresPaidPlan }),
    },
  };
}

const actions: PluginStoreActions = {
  onOpenDetail: () => {},
  onInstall: () => {},
  onUninstall: () => {},
  onSetEnabled: () => {},
  onUpdate: () => {},
  activeOperations: [],
  togglingPluginId: null,
};

async function renderCard(item: StorePluginItem): Promise<string> {
  const { PluginStoreCard } = await import("../src/settings/PluginStoreCard.js");
  const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreCard, { item, actions, locale: "en-US" }),
    ),
  );
}

async function renderDetail(item: StorePluginItem): Promise<string> {
  const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
  const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreDetailView, {
        item,
        actions,
        onRetryDescribe: () => {},
        onUsePrompt: () => {},
      }),
    ),
  );
}

describe("旧插件目录的独立桌面展示", () => {
  it.each([true, false, undefined])(
    "卡片忽略旧套餐字段 %s，并保留安装入口",
    async (requiresPaidPlan) => {
      const html = await renderCard(makeItem(requiresPaidPlan));
      expect(html).toContain("Pro Plugin");
      expect(html).toContain("Install");
      expect(html).not.toContain("plugin-store-paid-plan-badge");
      expect(html).not.toContain("Coding Plan");
    },
  );

  it.each([true, false, undefined])(
    "详情忽略旧套餐字段 %s，并保留安装入口",
    async (requiresPaidPlan) => {
      const html = await renderDetail(makeItem(requiresPaidPlan));
      expect(html).toContain("Pro Plugin");
      expect(html).toContain("Install");
      expect(html).not.toContain("plugin-store-paid-plan-badge");
      expect(html).not.toContain("Coding Plan");
    },
  );
});
