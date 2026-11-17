// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getV4FocusedPaneId,
  selectV4TaskById,
  waitForV4Pane,
} from "./e2e/helpers/v4-conversation.js";

let afterFirstPanePoll: (() => void) | undefined;
let panePolls: number;
let clicks: number;

function addPane(id: string, sessionId: string, focused = true, visible = true, active = true) {
  const shell = document.createElement("div");
  Object.assign(shell.dataset, {
    testid: `v4-pane-shell-${id}`,
    paneId: id,
    focused: String(focused),
    groupActive: String(active),
    visible: String(visible),
  });
  shell.innerHTML = `<div data-testid="v4-session-pane-${id}" data-session-id="${sessionId}"></div>`;
  vi.spyOn(shell, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        width: shell.dataset.visible === "true" ? 600 : 0,
        height: shell.dataset.visible === "true" ? 200 : 0,
      }) as DOMRect,
  );
  document.body.append(shell);
  return shell;
}

beforeEach(() => {
  panePolls = 0;
  clicks = 0;
  afterFirstPanePoll = undefined;
  vi.stubEnv("ZCODE_E2E_ARTIFACT_DIR", "");
  document.body.innerHTML = '<button data-testid="task-item-target"></button>';
  document.querySelector<HTMLButtonElement>("button")!.onclick = () => clicks++;
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    waitUntil: async (
      predicate: () => Promise<boolean>,
      options: { timeout?: number; timeoutMsg?: string } = {},
    ) => {
      const paneWait = options.timeoutMsg?.includes("pane") || options.timeoutMsg === "fixed-pane";
      for (let poll = 0; poll < 2; poll++) {
        if (paneWait) panePolls++;
        if (await predicate()) return;
        if (paneWait && poll === 0) afterFirstPanePoll?.();
      }
      throw new Error(options.timeoutMsg ?? "受控条件未满足");
    },
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("真实 task 导航等待当前活动 pane", () => {
  it("click 返回后首 poll 仍 B，受控焦点迁移后等待 A，而不是固定缓存 B", async () => {
    const old = addPane("b", "old-session");
    const target = addPane("a", "target", false, false);
    afterFirstPanePoll = () => {
      old.dataset.focused = old.dataset.visible = old.dataset.groupActive = "false";
      target.dataset.focused = target.dataset.visible = target.dataset.groupActive = "true";
    };
    await expect(selectV4TaskById("target")).resolves.toBeUndefined();
    expect(panePolls).toBe(2);
    expect(clicks).toBe(1);
  });

  it("DOM 首位 hidden/stale-focused B 不能抢占后面的真实可见 A", async () => {
    addPane("cached-b", "old-session", true, false);
    addPane("active-a", "target");
    await expect(selectV4TaskById("target")).resolves.toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("双可见栏只选择聚焦栏，不能仅取 first-visible", async () => {
    addPane("sibling", "other", false);
    addPane("active", "target");
    await expect(selectV4TaskById("target")).resolves.toBeUndefined();
  });

  it("可见但 groupInactive 的 stale-focused 目标不能使导航通过", async () => {
    addPane("inactive", "target", true, true, false);
    addPane("active", "other");
    await expect(selectV4TaskById("target")).rejects.toThrow();
  });

  it("目标仅在隐藏缓存中时，实际焦点错误 session 不能满足等待", async () => {
    addPane("hidden-target", "target", false, false);
    addPane("active-wrong", "other");
    await expect(selectV4TaskById("target")).rejects.toThrow();
  });

  it("两个可见活动聚焦候选必须拒绝，不能拿首个目标制造通过", async () => {
    addPane("first", "target");
    addPane("ambiguous", "other");
    await expect(selectV4TaskById("target")).rejects.toThrow("必须唯一");
  });

  it("pane-only 没有合法候选时返回 null，不要求 Composer 或 workspace bridge", async () => {
    addPane("cached", "target", true, false);
    await expect(getV4FocusedPaneId()).resolves.toBeNull();
  });

  it("显式 paneId 在焦点迁移后仍精确等待原 pane", async () => {
    const fixed = addPane("fixed", "loading");
    const sibling = addPane("sibling", "wrong", false);
    afterFirstPanePoll = () => {
      fixed.dataset.focused = "false";
      sibling.dataset.focused = "true";
      fixed.querySelector<HTMLElement>("[data-session-id]")!.dataset.sessionId = "target";
    };
    const result = await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "target",
      "fixed-pane",
      30_000,
      "fixed",
    );
    expect(result.sessionId).toBe("target");
    expect(panePolls).toBe(2);
    expect(clicks).toBe(0);
  });
});
