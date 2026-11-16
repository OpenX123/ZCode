// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme } from "@/useTheme.js";
import { createZCodeStore } from "@/store/index.js";
import type { IBroadcastService } from "@zcode/services";

beforeEach(() => {
  document.head.innerHTML = "";
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-zcode-browser-theme-surface");
  document.documentElement.removeAttribute("style");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyTheme", () => {
  it.each([
    ["zai-dark", "dark", "#161616"],
    ["zai-light", "light", "#f8f8f8"],
  ] as const)("把 %s 同步到已 opt-in 的浏览器主题表面", (theme, resolvedTheme, background) => {
    document.documentElement.setAttribute("data-zcode-browser-theme-surface", "light");
    document.documentElement.style.setProperty("--color-background", background);
    document.head.innerHTML = `
        <meta name="theme-color" content="#ffffff" />
        <meta name="color-scheme" content="light" />
      `;

    applyTheme(theme);

    expect(document.documentElement.getAttribute("data-zcode-browser-theme-surface")).toBe(
      resolvedTheme,
    );
    expect(document.documentElement.style.colorScheme).toBe(resolvedTheme);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      background,
    );
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      resolvedTheme,
    );
  });

  it("system 模式用浏览器偏好同步同一份 resolved theme", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    document.documentElement.setAttribute("data-zcode-browser-theme-surface", "light");
    document.documentElement.style.setProperty("--color-background", "#161616");

    applyTheme("system");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-zai-dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-zcode-browser-theme-surface")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#161616",
    );
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "dark",
    );
  });

  it("未 opt-in 的 Electron 页面只切换既有主题 class", () => {
    applyTheme("zai-dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-zai-dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("");
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(document.querySelector('meta[name="color-scheme"]')).toBeNull();
  });

  it("轻量 DOM shim 未提供浏览器表面能力时仍保留既有 class 切换", () => {
    const toggle = vi.fn();
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle },
      },
    });

    expect(() => applyTheme("zai-dark")).not.toThrow();
    expect(toggle).toHaveBeenCalledTimes(3);
  });
});

describe("主题偏好广播", () => {
  it("快捷切换只广播一次，其他窗口应用时不回环", () => {
    const receivers: Array<(message: { channel: string; payload: unknown }) => void> = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const broadcast = {
      send: vi.fn((message: { channel: string; payload: unknown }) => {
        sent.push(message);
        for (const receiver of receivers) receiver(message);
      }),
      onMessage: vi.fn((receiver: (message: { channel: string; payload: unknown }) => void) => {
        receivers.push(receiver);
        return { dispose: () => {} };
      }),
    } as unknown as IBroadcastService;
    const first = createZCodeStore(broadcast);
    const second = createZCodeStore(broadcast);

    first.getState().setTheme("zai-light");

    expect(first.getState().theme).toBe("zai-light");
    expect(second.getState().theme).toBe("zai-light");
    expect(sent.filter((message) => message.channel === "state:theme")).toEqual([
      { channel: "state:theme", payload: "zai-light" },
    ]);
    expect(localStorage.getItem("zcode-theme")).toBe("zai-light");
  });
});
