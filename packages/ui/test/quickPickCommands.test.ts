import { describe, expect, it, vi } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  createQuickPickCommands,
  QUICK_PICK_SECTION_ORDER,
} from "@/quickpick/quickPickCommands.js";

function createHandlers() {
  return {
    createTask: vi.fn(),
    openWorkspace: vi.fn(),
    openSettings: vi.fn(),
    openSkillsSettings: vi.fn(),
    openMcpSettings: vi.fn(),
    switchTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleTerminal: vi.fn(),
    togglePreview: vi.fn(),
    openTerminalTab: vi.fn(),
    openBrowserTab: vi.fn(),
    openReviewTab: vi.fn(),
  };
}

const shortcuts = {
  newTask: "⌘ N",
  openWorkspace: "⌘ O",
  toggleSidebar: "⌘ B",
  toggleTerminal: "⌘ J",
};

describe("createQuickPickCommands", () => {
  it("原生 Claude Code 命令使用既有终端入口，并在办公模式隐藏", () => {
    const handlers = createHandlers();
    const options = {
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      themeTarget: "dark" as const,
      shortcuts,
      handlers,
    };
    const command = createQuickPickCommands(options).find((item) => item.id === "open-claude-code");
    expect(command).toMatchObject({
      sectionId: "panels",
      titleId: "terminal.claudeCode.open",
      icon: "terminal",
    });
    command!.run();
    expect(handlers.openTerminalTab).toHaveBeenCalledWith("claude-code");
    expect(
      createQuickPickCommands({ ...options, supportsTerminal: false }).some(
        (item) => item.id === "open-claude-code",
      ),
    ).toBe(false);
  });

  it("通用模式过滤技术面板命令并保留浏览器和普通命令", () => {
    const commands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      supportsTerminal: false,
      supportsReview: false,
      themeTarget: "dark",
      shortcuts,
      handlers: createHandlers(),
    });
    const ids = commands.map((command) => command.id);
    expect(ids).not.toContain("toggle-terminal");
    expect(ids).not.toContain("add-terminal-tab");
    expect(ids).not.toContain("add-review-tab");
    expect(ids).toContain("add-browser-tab");
    expect(ids).toContain("new-task");
    expect(ids).toContain("settings");
  });

  it("creates the starter command registry in stable sections", () => {
    const commands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      themeTarget: "dark",
      shortcuts,
      handlers: createHandlers(),
    });

    expect(commands.map((command) => command.id)).toEqual([
      "new-task",
      "open-workspace",
      "suggested-settings",
      "toggle-sidebar",
      "toggle-terminal",
      "toggle-preview",
      "add-terminal-tab",
      "open-claude-code",
      "add-browser-tab",
      "add-review-tab",
      "settings",
      "switch-theme",
      "skills-settings",
      "mcp-settings",
    ]);
    expect(commands.find((command) => command.id === "open-workspace")).toMatchObject({
      sectionId: "suggested",
      shortcut: "⌘ O",
      disabled: false,
    });
    expect(commands.find((command) => command.id === "new-task")).toMatchObject({
      sectionId: "suggested",
    });
    expect(commands.find((command) => command.id === "suggested-settings")).toMatchObject({
      sectionId: "suggested",
    });
    expect(commands.find((command) => command.id === "settings")).toMatchObject({
      sectionId: "configure",
    });
    expect(commands.find((command) => command.id === "switch-theme")).toMatchObject({
      sectionId: "configure",
      titleId: "quickPick.command.switchThemeToDark",
      icon: "themeDark",
    });
    expect(commands.find((command) => command.id === "skills-settings")).toMatchObject({
      sectionId: "configure",
    });
    expect(commands.find((command) => command.id === "mcp-settings")).toMatchObject({
      sectionId: "configure",
    });
    expect(commands.find((command) => command.id === "toggle-sidebar")).toMatchObject({
      sectionId: "panels",
      shortcut: "⌘ B",
      icon: "sidebarClose",
    });
    expect(commands.find((command) => command.id === "toggle-terminal")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "toggle-preview")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "add-terminal-tab")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "add-browser-tab")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "add-review-tab")).toMatchObject({
      sectionId: "panels",
    });
  });

  it("keeps unavailable workspace opening visible but disabled", () => {
    const commands = createQuickPickCommands({
      allowOpenWorkspace: false,
      isSidebarVisible: true,
      themeTarget: "dark",
      shortcuts,
      handlers: createHandlers(),
    });

    expect(commands.find((command) => command.id === "open-workspace")).toMatchObject({
      disabled: true,
    });
  });

  it("matches the sidebar toggle icon to the current sidebar state", () => {
    const closedSidebarCommands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: false,
      themeTarget: "dark",
      shortcuts,
      handlers: createHandlers(),
    });

    expect(closedSidebarCommands.find((command) => command.id === "toggle-sidebar")).toMatchObject({
      icon: "sidebarOpen",
    });
  });

  it("omits embedded browser commands when the shell does not support browser tabs", () => {
    const commands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      supportsEmbeddedBrowser: false,
      themeTarget: "dark",
      shortcuts,
      handlers: createHandlers(),
    });

    expect(commands.map((command) => command.id)).not.toContain("toggle-preview");
    expect(commands.map((command) => command.id)).not.toContain("add-browser-tab");
  });

  it("runs the registered panel handler", () => {
    const handlers = createHandlers();
    const command = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      themeTarget: "dark",
      shortcuts,
      handlers,
    }).find((item) => item.id === "add-browser-tab");

    command?.run();

    expect(handlers.openBrowserTab).toHaveBeenCalledTimes(1);
  });

  it("调用当前仍提供的配置命令", () => {
    const handlers = createHandlers();
    const commands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      themeTarget: "dark",
      shortcuts,
      handlers,
    });

    commands.find((item) => item.id === "skills-settings")?.run();
    commands.find((item) => item.id === "mcp-settings")?.run();

    expect(handlers.openSkillsSettings).toHaveBeenCalledTimes(1);
    expect(handlers.openMcpSettings).toHaveBeenCalledTimes(1);
  });

  it("has locale messages for every visible command label", () => {
    const commands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      themeTarget: "light",
      shortcuts,
      handlers: createHandlers(),
    });
    expect(commands.find((command) => command.id === "switch-theme")).toMatchObject({
      titleId: "quickPick.command.switchThemeToLight",
      icon: "themeLight",
    });
    const messageIds = new Set([
      "quickPick.title",
      "quickPick.description",
      "quickPick.placeholder",
      "quickPick.empty",
      "quickPick.commandFailed",
      "commandCenter.scopeTabs",
      "commandCenter.scope.all",
      "commandCenter.scope.commands",
      "commandCenter.scope.conversations",
      "commandCenter.scope.files",
      "commandCenter.section.recentChanges",
      "commandCenter.section.recentTasks",
      "commandCenter.empty.recentChanges",
      "commandCenter.empty.recentTasks",
      ...commands.map((command) => command.titleId),
      ...QUICK_PICK_SECTION_ORDER.map((sectionId) => `quickPick.section.${sectionId}`),
    ]);

    for (const id of messageIds) {
      expect(zhCN[id], `zh-CN missing ${id}`).toBeTruthy();
      expect(enUS[id], `en-US missing ${id}`).toBeTruthy();
    }
  });

  it("独立桌面命令目录不再提供已退役的官方账号与商业入口", () => {
    const commands = createQuickPickCommands({
      allowOpenWorkspace: true,
      isSidebarVisible: true,
      themeTarget: "dark",
      shortcuts,
      handlers: createHandlers(),
    });
    for (const id of ["login", "logout", "feedback", "community", "product-docs"]) {
      expect(commands.some((command) => command.id === id)).toBe(false);
    }
  });
});
