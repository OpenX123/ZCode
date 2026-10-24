import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_AUTOMATIONS_OPEN, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";

const state = vi.hoisted(() => ({
  mode: "disabled",
  settingsVisible: false,
  automationsVisible: false,
  calls: [] as string[],
  commands: [] as Array<{ name: string }>,
  waits: 0,
}));
vi.mock("./e2e/helpers/desktop-app.js", () => ({
  clickTestIdByDom: vi.fn(async (id: string) => {
    state.calls.push(`dom:${id}`);
    if (id === "settings-back-button") state.settingsVisible = false;
    if (id === "task-settings-button") state.settingsVisible = true;
  }),
  clickTestIdByWebDriver: vi.fn(async (id: string) => {
    state.calls.push(`visible:${id}`);
    if (id === TID_AUTOMATIONS_OPEN) state.automationsVisible = true;
  }),
  setInputValueByTestIdDom: vi.fn(),
  readSettings: vi.fn(async () => ({ dynamicWorkflowMode: state.mode })),
  waitForDefaultWorkspaceReady: vi.fn(async () => {
    state.calls.push("coding:ready");
    if (state.automationsVisible) throw new Error("自动化页没有 coding composer");
  }),
}));
vi.mock("./e2e/helpers/v4-conversation.js", () => ({
  getV4SlashOptionIds: vi.fn(),
  hasV4SlashPanel: vi.fn(),
}));
import {
  configureLocalDynamicWorkflowMode,
  openAutomationsPage,
} from "./e2e/helpers/dynamic-workflow-gray.js";

beforeEach(() => {
  state.mode = "disabled";
  state.calls = [];
  state.settingsVisible = false;
  state.automationsVisible = false;
  state.commands = [];
  state.waits = 0;
  vi.stubGlobal("window", {
    __zcodeTabStoreE2E: { getState: () => ({ activeWorkspacePath: "/workspace" }) },
    __zcodeSessionStoreE2E: {
      getState: () => ({ getWorkspaceState: () => ({ slashCommands: state.commands }) }),
    },
  });
  vi.stubGlobal("$", (selector: string) => ({
    isDisplayed: async () =>
      selector.includes("settings-page") ? state.settingsVisible : state.automationsVisible,
    waitForDisplayed: async (options?: { reverse?: boolean }) => {
      if (selector.includes("settings-page")) {
        expect(state.settingsVisible).toBe(!options?.reverse);
        if (options?.reverse) state.calls.push("settings:hidden");
      } else if (selector === "[data-automations-content]") {
        expect(state.automationsVisible).toBe(true);
      }
    },
  }));
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    waitUntil: async (predicate: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await predicate()) return;
        state.waits += 1;
        state.commands =
          attempt === 0 ? [{ name: "goal" }, { name: "workflow" }] : [{ name: "goal" }];
      }
      throw new Error("未等待到最新 CLI 工作流策略");
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("工作流 E2E 真实前置屏障", () => {
  it("配置关闭不能只等待磁盘，必须等 goal 目录和已应用的关闭策略", async () => {
    await configureLocalDynamicWorkflowMode("disabled");
    expect(state.waits).toBe(2);
    expect(state.commands).toEqual([{ name: "goal" }]);
  });

  it("设置页打开时先返回工作区，再通过可见入口进入自动化", async () => {
    state.settingsVisible = true;
    state.commands = [{ name: "goal" }];
    await openAutomationsPage();
    expect(state.calls).toContain(`dom:${TID_SETTINGS_BACK_BUTTON}`);
    expect(state.calls).toContain(`visible:${TID_AUTOMATIONS_OPEN}`);
    expect(state.calls.indexOf(`dom:${TID_SETTINGS_BACK_BUTTON}`)).toBeLessThan(
      state.calls.indexOf(`visible:${TID_AUTOMATIONS_OPEN}`),
    );
    expect(state.calls).not.toContain("coding:ready");
    expect(state.calls.indexOf("settings:hidden")).toBeLessThan(
      state.calls.indexOf(`visible:${TID_AUTOMATIONS_OPEN}`),
    );
  });

  it("从自动化页打开设置后复用返回页，仍等待新工作流策略而不等待 composer", async () => {
    state.settingsVisible = true;
    state.automationsVisible = true;
    await openAutomationsPage();

    expect(state.calls).toEqual([`dom:${TID_SETTINGS_BACK_BUTTON}`, "settings:hidden"]);
    expect(state.waits).toBe(2);
    expect(state.commands).toEqual([{ name: "goal" }]);
  });
});
