// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectSectionSelector,
  readProjectTaskRowState,
  startDraftFromProject,
  waitForTaskRowInProject,
} from "./e2e/helpers/project-sidebar.js";

const workspacePath = "/home/zcodee2e/workspace-a";
const scope = {
  projectId: "project-created-this-run",
  hostId: "source-this-run",
  workspaceIdentity: "remote:this-run:workspace-a",
  projectName: "workspace-a (3)",
};

function addProject(project = scope, taskId?: string) {
  const section = document.createElement("section");
  section.dataset.projectId = project.projectId;
  section.dataset.projectHost = project.hostId;
  section.dataset.projectWorkspaceIdentity = project.workspaceIdentity;
  section.dataset.projectName = project.projectName;
  section.innerHTML =
    '<div data-testid="virtual-project-row"></div><button data-testid="virtual-project-toggle" aria-expanded="true"></button><button data-testid="virtual-project-create-task"></button>';
  if (taskId) {
    section.insertAdjacentHTML(
      "beforeend",
      `<div data-testid="task-item-${taskId}" class="bg-selected"></div>`,
    );
  }
  document.body.append(section);
  return section;
}

function addSameNameSibling(taskId?: string) {
  return addProject(
    {
      ...scope,
      projectId: "existing-project",
      workspaceIdentity: "remote:existing:workspace-a",
      projectName: "workspace-a",
    },
    taskId,
  );
}

function webdriverElement(element: Element | null) {
  return {
    waitForDisplayed: async () => expect(element).not.toBeNull(),
    moveTo: async () => expect(element).not.toBeNull(),
    click: async () => (element as HTMLElement).click(),
    $: (selector: string) => webdriverElement(element?.querySelector(selector) ?? null),
  };
}

beforeEach(() => {
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    waitUntil: async (predicate: () => Promise<boolean>) => {
      if (!(await predicate())) throw new Error("受控等待条件未满足");
    },
  });
  vi.stubGlobal("$", (selector: string) => webdriverElement(document.querySelector(selector)));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__zcodeTabStoreE2E;
  delete (window as unknown as Record<string, unknown>).__zcodeSessionStoreE2E;
});

describe("SSH E2E 侧栏的稳定项目作用域", () => {
  it("实际显示名带后缀时按新项目 ID/Host/identity 定位并等待其任务", async () => {
    addSameNameSibling();
    const created = addProject(scope, "target");
    expect(document.querySelector(projectSectionSelector(workspacePath, scope))).toBe(created);
    await expect(
      waitForTaskRowInProject("target", workspacePath, { projectScope: scope }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { ...scope, projectId: "wrong-id" },
    { ...scope, workspaceIdentity: "remote:wrong:workspace-a" },
    { ...scope, hostId: "wrong-host" },
  ])("显式作用域不匹配不能回退到 basename: %j", async (wrongScope) => {
    addSameNameSibling("target");
    addProject(scope, "target");
    expect(await readProjectTaskRowState("target", workspacePath, wrongScope)).toMatchObject({
      exists: false,
      inProject: false,
    });
    await expect(
      waitForTaskRowInProject("target", workspacePath, { projectScope: wrongScope }),
    ).rejects.toThrow();
  });

  it("只在兄弟项目出现的任务不能计入正确归属", async () => {
    addSameNameSibling("foreign");
    addProject();
    expect(await readProjectTaskRowState("foreign", workspacePath, scope)).toMatchObject({
      exists: false,
      inProject: false,
    });
  });

  it("任务状态在指定项目内读取，不采用全局第一条相同 task id", async () => {
    const sibling = addSameNameSibling("target");
    sibling.querySelector('[data-testid="task-item-target"]')!.innerHTML =
      '<span data-error-indicator="true"></span>';
    addProject(scope, "target");
    expect(await readProjectTaskRowState("target", workspacePath, scope)).toMatchObject({
      exists: true,
      inProject: true,
      active: true,
      error: false,
    });
  });

  it("重复的显式项目候选必须拒绝，不能取第一项", async () => {
    addProject(scope, "target");
    addProject(scope, "target");
    await expect(readProjectTaskRowState("target", workspacePath, scope)).rejects.toThrow(
      "必须唯一",
    );
  });

  it("未提供显式项目作用域时保留旧 basename 合同", async () => {
    const sibling = addSameNameSibling("legacy");
    addProject();
    expect(document.querySelector(projectSectionSelector(workspacePath))).toBe(sibling);
    expect(await readProjectTaskRowState("legacy", workspacePath)).toMatchObject({
      exists: true,
      inProject: true,
    });
  });

  it("显式项目草稿用实际显示名核对，同时保持活动 identity 与新建版本屏障", async () => {
    addSameNameSibling();
    const created = addProject();
    let version = 1;
    created
      .querySelector('[data-testid="virtual-project-create-task"]')!
      .addEventListener("click", () => {
        version += 1;
      });
    Object.assign(window, {
      __zcodeSessionStoreE2E: {
        getState: () => ({
          workspaces: { [scope.workspaceIdentity]: { draftFocusVersion: version } },
        }),
      },
      __zcodeTabStoreE2E: {
        getState: () => ({ activeWorkspaceIdentity: scope.workspaceIdentity }),
      },
    });
    const shell = document.createElement("div");
    shell.dataset.testid = "v4-pane-shell-active";
    shell.dataset.focused = "true";
    shell.innerHTML =
      '<div data-testid="v4-session-pane-active" data-session-id="draft"><textarea data-testid="v4-composer-input"></textarea><button data-testid="composer-workspace-trigger"></button></div>';
    (shell.querySelector("button") as HTMLElement).innerText = scope.projectName;
    document.body.append(shell);
    await expect(
      startDraftFromProject(workspacePath, {
        workspaceIdentity: scope.workspaceIdentity,
        projectScope: scope,
      }),
    ).resolves.toBeUndefined();
    expect(version).toBe(2);
  });
});
