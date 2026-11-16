// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import type { Theme } from "@/useTheme.js";

vi.mock("@/desktop-updates/index.js", () => ({
  DesktopUpdateButton: () => null,
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({}) }));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => "",
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: object) => unknown) =>
    selector({ interfaceMode: "coding", setInterfaceMode: vi.fn() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        ({
          "settings.title": "Settings",
          "sidebar.settings.switchToLight": "Switch to light theme",
          "sidebar.settings.switchToDark": "Switch to dark theme",
        })[id] ?? id,
    },
  }),
}));

let systemDark = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  localStorage.clear();
  systemDark = false;
  listeners.clear();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return systemDark;
    },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function footer(theme: Theme, onThemeChange = vi.fn()) {
  return render(
    createElement(WorkspaceSidebarFooter, {
      theme,
      onThemeChange,
      onSettingsButtonClick: vi.fn(),
    }),
  );
}

describe("侧栏主题快捷按钮", () => {
  it.each([
    ["zai-dark", "Switch to light theme", "lucide-sun", "zai-light"],
    ["zai-light", "Switch to dark theme", "lucide-moon", "zai-dark"],
  ] as const)("%s 点击后切换到明确主题", (theme, label, icon, target) => {
    const onThemeChange = vi.fn();
    footer(theme, onThemeChange);
    const button = screen.getByRole("button", { name: label });
    expect(button.getAttribute("title")).toBe(label);
    expect(button.querySelector(`svg.${icon}`)).not.toBeNull();
    fireEvent.click(button);
    expect(onThemeChange).toHaveBeenCalledExactlyOnceWith(target);
  });

  it.each([
    [false, "Switch to dark theme", "zai-dark"],
    [true, "Switch to light theme", "zai-light"],
  ] as const)("System 当前暗色=%s 时按解析结果切换", (dark, label, target) => {
    systemDark = dark;
    const onThemeChange = vi.fn();
    footer("system", onThemeChange);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onThemeChange).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("System 偏好变化只更新图标和名称，不写主题偏好", () => {
    const onThemeChange = vi.fn();
    footer("system", onThemeChange);
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
    act(() => {
      systemDark = true;
      for (const listener of listeners) listener();
    });
    const button = screen.getByRole("button", {
      name: "Switch to light theme",
    });
    expect(button.querySelector("svg.lucide-sun")).not.toBeNull();
    expect(onThemeChange).not.toHaveBeenCalled();
  });
});
