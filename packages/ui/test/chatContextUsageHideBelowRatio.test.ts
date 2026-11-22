// @vitest-environment jsdom
import { createContext, createElement, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";

const contextOpenContext = createContext(false);

vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    createElement(contextOpenContext.Provider, { value: Boolean(open) }, children),
  ContextContent: ({ children }: { children?: ReactNode }) =>
    useContext(contextOpenContext) ? createElement("div", null, children) : null,
  ContextContentBody: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("div", props, children),
  ContextTrigger: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children ?? "context"),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

function renderUsage(used: number, hideBelowRatio?: number) {
  return render(
    createElement(ChatContextUsage, {
      intl: { formatMessage: ({ id }: { id: string }) => id } as never,
      locale: "en-US",
      selectedProvider: "glm",
      taskUsage: { used, size: 1_000_000 },
      hideBelowRatio,
    }),
  );
}

// 1.5.1：外部引擎 composer 低用量时隐藏用量环，避免静态环被误认为加载转圈。
describe("ChatContextUsage hideBelowRatio", () => {
  afterEach(() => cleanup());

  it("低于阈值时不渲染入口", () => {
    renderUsage(17_000, 0.2);
    expect(screen.queryByRole("button", { name: "chat.contextUsage" })).toBeNull();
  });

  it("达到阈值时渲染入口", () => {
    renderUsage(250_000, 0.2);
    expect(screen.getByRole("button", { name: "chat.contextUsage" })).toBeTruthy();
  });

  it("未传阈值时保持常显（原生引擎压缩入口）", () => {
    renderUsage(17_000);
    expect(screen.getByRole("button", { name: "chat.contextUsage" })).toBeTruthy();
  });
});
