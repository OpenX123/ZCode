// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSSHCreationOriginDraft,
  selectSSHRemoteDirectory,
} from "./e2e/helpers/ssh-remote-p0.js";

vi.mock("./e2e/helpers/desktop-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  waitForWorkspaceApp: vi.fn(),
}));

const path = "/home/zcodee2e/workspace-a";
const identity = `remote:server:source-this-run:${path}`;
const scope = {
  projectId: "created-this-run",
  hostId: "remote:server:source-this-run",
  workspaceIdentity: identity,
  projectName: "workspace-a (7)",
};
const origin = {
  tabId: "local-origin-tab",
  workspacePath: "/local",
  workspaceIdentity: null,
};
const completion = { kind: "origin-draft" as const, origin };
let tabIdentity: string;
let activeSession: string | null;
let candidateSession: string | null;
let projectClicks: number;
let settingsClicks: number;
let waitOptions: Array<{ timeout?: number }>;

function addProject() {
  const section = document.createElement("section");
  section.dataset.projectId = scope.projectId;
  section.dataset.projectHost = scope.hostId;
  section.dataset.projectWorkspaceIdentity = scope.workspaceIdentity;
  section.dataset.projectName = scope.projectName;
  section.innerHTML = '<button data-testid="virtual-project-create-task"></button>';
  section.querySelector("button")!.onclick = () => projectClicks++;
  document.body.append(section);
}

function element(selector: string, parent: ParentNode = document) {
  const found = parent.querySelector<HTMLElement>(selector);
  return {
    isExisting: async () => Boolean(found),
    isDisplayed: async () => Boolean(found),
    waitForDisplayed: async () => expect(found).not.toBeNull(),
    setValue: async () => expect(found).not.toBeNull(),
    getAttribute: async (name: string) => found?.getAttribute(name) ?? null,
    moveTo: async () => expect(found).not.toBeNull(),
    click: async () => found!.click(),
    $: (child: string) => element(child, found!),
  };
}

beforeEach(() => {
  tabIdentity = identity;
  activeSession = "session-real-a";
  candidateSession = "session-real-a";
  projectClicks = 0;
  settingsClicks = 0;
  waitOptions = [];
  document.body.innerHTML = `
    <input data-testid="virtual-project-name">
    <div data-testid="virtual-project-root-name" title="${path}"></div>
    <button data-testid="virtual-project-save"></button>
    <button data-testid="project-folder-trust-confirm"></button>
    <button data-testid="settings-back-button"></button>
    <div data-testid="v4-pane-shell-active" data-pane-id="active" data-focused="true" data-group-active="true">
      <div data-testid="v4-session-pane-active" data-session-id="draft">
        <div data-testid="v4-composer"><div data-testid="v4-composer-input" contenteditable="true"></div>
          <button data-testid="composer-workspace-trigger">${scope.projectName}</button>
        </div>
      </div>
    </div>`;
  document.querySelector<HTMLButtonElement>(
    '[data-testid="project-folder-trust-confirm"]',
  )!.onclick = addProject;
  document.querySelector<HTMLButtonElement>('[data-testid="settings-back-button"]')!.onclick = () =>
    settingsClicks++;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 600,
    height: 200,
  } as DOMRect);
  Object.assign(window, {
    __zcodeTabStoreE2E: {
      getState: () => ({
        activeTabId: "new-remote-tab",
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tabIdentity,
        tabs: [
          { id: origin.tabId, kind: "workspace", workspacePath: origin.workspacePath },
          {
            id: "new-remote-tab",
            kind: "workspace",
            workspacePath: path,
            workspaceIdentity: tabIdentity,
            remoteSessionId: activeSession,
            remoteTarget: { kind: "ssh", host: "synthetic-host" },
          },
          ...(candidateSession !== activeSession
            ? [
                {
                  workspacePath: path,
                  workspaceIdentity: identity,
                  remoteSessionId: candidateSession,
                },
              ]
            : []),
        ],
      }),
    },
    __zcodeSessionStoreE2E: {
      getState: () => ({ workspaces: { [identity]: { activeTaskId: null } } }),
    },
  });
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    waitUntil: async (predicate: () => Promise<boolean>, options: { timeout?: number } = {}) => {
      waitOptions.push(options);
      if (!(await predicate())) throw new Error("受控等待条件未满足");
    },
  });
  vi.stubGlobal("$", (selector: string) => element(selector));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__zcodeTabStoreE2E;
  delete (window as unknown as Record<string, unknown>).__zcodeSessionStoreE2E;
});

type SelectOptions = NonNullable<Parameters<typeof selectSSHRemoteDirectory>[2]> & {
  completion?: typeof completion;
};

describe("SSH 创建完成策略只表达一个创建意图", () => {
  it("发起前读取活动 Tab 的有效空草稿，只返回身份白名单", async () => {
    await expect(readSSHCreationOriginDraft("A")).resolves.toEqual({
      tabId: "new-remote-tab",
      workspacePath: path,
      workspaceIdentity: identity,
    });
  });

  it.each(["nonempty", "sent", "unfocused"])("无效原草稿 %s 在发起前失败", async (fault) => {
    if (fault === "nonempty")
      document.querySelector('[data-testid="v4-composer-input"]')!.textContent = "unsent fixture";
    if (fault === "sent")
      document.querySelector<HTMLElement>('[data-session-id="draft"]')!.dataset.sessionId = "sent";
    if (fault === "unfocused")
      document.querySelector<HTMLElement>('[data-pane-id="active"]')!.dataset.focused = "false";
    await expect(readSSHCreationOriginDraft("A")).rejects.toThrow("归属明确的活动空草稿");
    expect(projectClicks).toBe(0);
    expect(settingsClicks).toBe(0);
  });

  it("首次 A 显式等待原草稿自动接续，不返回设置或重复侧栏新建，允许绑定后新 Tab", async () => {
    const observed = vi.fn();
    await selectSSHRemoteDirectory(path, "A", {
      completion,
      onProjectCreated: observed,
    } as SelectOptions);
    expect(observed).toHaveBeenCalledExactlyOnceWith(scope);
    expect(settingsClicks).toBe(0);
    expect(projectClicks).toBe(0);
    expect(waitOptions.some((options) => options.timeout === 120_000)).toBe(true);
  });

  it("B 与旧默认仍返回设置并执行一次原侧栏新建入口", async () => {
    await selectSSHRemoteDirectory(path, "B");
    expect(settingsClicks).toBe(1);
    expect(projectClicks).toBe(1);
  });

  it("只增加观察回调不会暗中选择自动接续", async () => {
    const observed = vi.fn();
    await selectSSHRemoteDirectory(path, "B", { onProjectCreated: observed });
    expect(observed).toHaveBeenCalledExactlyOnceWith(scope);
    expect(settingsClicks).toBe(1);
    expect(projectClicks).toBe(1);
  });

  it.each(["identity", "missing-session", "inactive-session", "wrong-project", "sent-draft"])(
    "显式 A 不接受错误目标 %s，也不 fallback",
    async (fault) => {
      if (fault === "identity") tabIdentity = `remote:server:other:${path}`;
      if (fault === "missing-session") activeSession = candidateSession = null;
      if (fault === "inactive-session") activeSession = null;
      if (fault === "wrong-project")
        document.querySelector('[data-testid="composer-workspace-trigger"]')!.textContent =
          "sibling";
      if (fault === "sent-draft")
        document.querySelector<HTMLElement>('[data-session-id="draft"]')!.dataset.sessionId =
          "task-a";
      await expect(
        selectSSHRemoteDirectory(path, "A", { completion } as SelectOptions),
      ).rejects.toThrow();
      expect(settingsClicks).toBe(0);
      expect(projectClicks).toBe(0);
    },
  );
});
