import { basename as posixBasename } from "node:path/posix";
import { basename as win32Basename } from "node:path/win32";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_PANE_SHELL,
  TID_V4_SESSION_PANE,
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  TID_VIRTUAL_PROJECT_FILES,
  TID_VIRTUAL_PROJECT_MENU,
  TID_VIRTUAL_PROJECT_ROW,
  TID_VIRTUAL_PROJECT_TOGGLE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  testId,
  virtualProjectActionTestId,
} from "@zcode/shared/test-ids";

/** 开始真实项目拖拽；调用方继续验证并通过 Escape / releaseActions 取消。 */
export async function startProjectPointerDrag(selector: string) {
  await browser.releaseActions();
  const position = await browser.execute((query) => {
    const rect = document.querySelector(query)!.getBoundingClientRect();
    return {
      x: Math.round(rect.left + 14),
      y: Math.round(rect.top + rect.height / 2),
      top: rect.top,
    };
  }, selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "project-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: position.x, y: position.y, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: position.x, y: position.y + 8, duration: 0 },
      ],
    },
  ]);
  // 跨阈值的事件只负责激活 sensor；等待该 owner 的状态，再发第二次位移，避免事件合并造成零位移。
  await browser.waitUntil(async () => (await $(selector).getAttribute("aria-pressed")) === "true", {
    timeout: 5000,
    timeoutMsg: "项目拖拽未激活",
  });
  await browser.performActions([
    {
      type: "pointer",
      id: "project-drag",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", x: position.x, y: position.y + 24, duration: 0 }],
    },
  ]);
  return position;
}

/**
 * 项目侧栏 E2E 定位 helper。
 *
 * 2026-09 虚拟项目重构后侧栏不再渲染真实目录节点（旧 TID_WORKSPACE_ITEM），
 * 老 workspace 首次迁移成「同名单 root 项目」：项目名 = 目录 basename
 * （与 packages/services/src/project-storage/migrate-projects.ts 同规则），
 * 项目 `<section>` 带 data-project-id / data-project-name。旧调用默认按项目名定位，
 * 夹具的 workspace basename 彼此唯一（ZCodeProject、PassiveWorkspace-01…）；
 * 需要允许既有重名项目的调用显式传递实际观察到的 SidebarProjectScope。
 */
export function projectNameForWorkspace(workspacePath: string): string {
  return (
    (workspacePath.includes("\\") ? win32Basename(workspacePath) : posixBasename(workspacePath)) ||
    workspacePath
  );
}

/** 真实创建后观察到的项目身份；显示名仅用于草稿标题核对，不参与身份定位。 */
export interface SidebarProjectScope {
  projectId: string;
  hostId: string;
  workspaceIdentity: string;
  projectName: string;
}

export function projectSectionSelector(
  workspacePath: string,
  projectScope?: SidebarProjectScope,
): string {
  // 原因：合法同名项目会自动带后缀；显式 ID 必须连同 Host/identity 匹配，不能回退 basename。
  if (projectScope) {
    return `section[data-project-id=${JSON.stringify(projectScope.projectId)}][data-project-host=${JSON.stringify(projectScope.hostId)}][data-project-workspace-identity=${JSON.stringify(projectScope.workspaceIdentity)}]`;
  }
  return `[data-project-id][data-project-name=${JSON.stringify(projectNameForWorkspace(workspacePath))}]`;
}

export function projectRowSelector(
  workspacePath: string,
  projectScope?: SidebarProjectScope,
): string {
  return `${projectSectionSelector(workspacePath, projectScope)} [data-testid="${TID_VIRTUAL_PROJECT_ROW}"]`;
}

interface WaitOptions {
  timeout?: number;
  timeoutMsg?: string;
  projectScope?: SidebarProjectScope;
}

async function projectRowExists(
  workspacePath: string,
  projectScope?: SidebarProjectScope,
): Promise<boolean> {
  let count: number;
  try {
    count = await browser.execute(
      (selector) => document.querySelectorAll(selector).length,
      projectRowSelector(workspacePath, projectScope),
    );
  } catch {
    // renderer reload 期间 WebDriver 会短暂失去执行上下文，按未就绪处理。
    return false;
  }
  if (projectScope && count > 1) throw new Error(`显式项目行必须唯一，实际 ${count}`);
  return count > 0;
}

export async function waitForProjectRow(
  workspacePath: string,
  {
    timeout = 30_000,
    timeoutMsg = `侧栏没有显示项目: ${workspacePath}`,
    projectScope,
  }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(() => projectRowExists(workspacePath, projectScope), {
    timeout,
    interval: 100,
    timeoutMsg,
  });
}

export async function waitForProjectRowGone(
  workspacePath: string,
  { timeout = 30_000, timeoutMsg = `项目移除后仍在侧栏: ${workspacePath}` }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(async () => !(await projectRowExists(workspacePath)), {
    timeout,
    interval: 100,
    timeoutMsg,
  });
}

/** 等待一组 workspace 对应的项目行全部出现在侧栏（启动恢复 / 首次迁移完成）。 */
export async function waitForRestoredProjects(
  workspacePaths: string[],
  timeout = 30_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const workspacePath of workspacePaths) {
        if (!(await projectRowExists(workspacePath))) return false;
      }
      return true;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${workspacePaths.length} 个恢复 workspace 没有全部出现在项目侧栏`,
    },
  );
}

async function readProjectExpanded(
  workspacePath: string,
  projectScope?: SidebarProjectScope,
): Promise<boolean> {
  return browser.execute(
    (selector, toggleTestId, requireUnique) => {
      const sections = document.querySelectorAll(selector);
      if (requireUnique && sections.length > 1)
        throw new Error(`显式项目必须唯一，实际 ${sections.length}`);
      return (
        sections[0]
          ?.querySelector(`[data-testid="${toggleTestId}"]`)
          ?.getAttribute("aria-expanded") === "true"
      );
    },
    projectSectionSelector(workspacePath, projectScope),
    TID_VIRTUAL_PROJECT_TOGGLE,
    Boolean(projectScope),
  );
}

/** 确保项目行已展开（任务列表可见）；对应旧 ensureWorkspaceItemExpanded。 */
export async function ensureProjectExpanded(
  workspacePath: string,
  timeout = 30_000,
): Promise<void> {
  await waitForProjectRow(workspacePath, { timeout });
  if (!(await readProjectExpanded(workspacePath))) {
    await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_TOGGLE, {
      timeout: 15_000,
      timeoutMsg: `侧栏项目不可展开: ${workspacePath}`,
    });
  }
  // Bug 根因：慢渲染环境下 DOM click 成功只代表事件已经派发，项目树的 React
  // 展开提交仍可能在后续帧；统一等待 aria 终态，避免各 case 提前查找 task。
  await browser.waitUntil(() => readProjectExpanded(workspacePath), {
    timeout: 15_000,
    timeoutMsg: `侧栏项目没有完成展开: ${workspacePath}`,
  });
}

/** 真实 hover 项目行；hover 操作区（文件树 / 新建任务 / 更多）按 hover 挂载透明度。 */
export async function hoverProjectRow(workspacePath: string, timeout = 15_000): Promise<void> {
  const row = $(projectRowSelector(workspacePath));
  await row.waitForDisplayed({ timeout, timeoutMsg: `侧栏没有可悬停的项目行: ${workspacePath}` });
  await row.moveTo();
}

/** DOM 点击项目 section 内某个 data-testid（toggle / files / create-task / menu…）。 */
export async function clickProjectAction(
  workspacePath: string,
  actionTestId: string,
  {
    timeout = 15_000,
    timeoutMsg = `项目 ${workspacePath} 没有可点击的 ${actionTestId}`,
  }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, targetTestId) => {
          const target = document
            .querySelector(selector)
            ?.querySelector<HTMLButtonElement>(`[data-testid="${targetTestId}"]`);
          if (!target || target.disabled) return false;
          target.click();
          return true;
        },
        projectSectionSelector(workspacePath),
        actionTestId,
      ),
    { timeout, interval: 100, timeoutMsg },
  );
}

/** 打开项目主要目录的文件树面板；对应旧「hover workspace 行 → 文件树按钮」。 */
export async function openProjectFileTree(
  workspacePath: string,
  { timeout = 15_000, timeoutMsg = "没有找到项目文件树入口" }: WaitOptions = {},
): Promise<void> {
  await hoverProjectRow(workspacePath, timeout);
  await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_FILES, { timeout, timeoutMsg });
  await browser.waitUntil(
    () =>
      browser.execute(
        (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
        TID_WORKSPACE_FILE_TREE_PANEL,
      ),
    { timeout, timeoutMsg: "文件树面板没有打开" },
  );
}

/** 从项目行发起新建任务草稿（cwd = 项目主要目录）。 */
export async function startDraftFromProject(
  workspacePath: string,
  options: { workspaceIdentity?: string; projectScope?: SidebarProjectScope } = {},
): Promise<void> {
  const { projectScope } = options;
  if (
    projectScope &&
    options.workspaceIdentity &&
    options.workspaceIdentity !== projectScope.workspaceIdentity
  )
    throw new Error("显式项目与草稿 workspace identity 不匹配");
  const workspaceIdentity = projectScope?.workspaceIdentity ?? options.workspaceIdentity;
  const draftKey = workspaceIdentity?.trim() || workspacePath;
  const previousDraftVersion = await browser.execute((key) => {
    const bridge = (
      window as unknown as {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { draftFocusVersion?: number }> };
        };
      }
    ).__zcodeSessionStoreE2E;
    return bridge?.getState().workspaces[key]?.draftFocusVersion ?? 0;
  }, draftKey);
  if (projectScope) {
    await waitForProjectRow(workspacePath, { projectScope });
    const project = $(projectSectionSelector(workspacePath, projectScope));
    await project.moveTo();
    await project.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
  } else if (options.workspaceIdentity) {
    // 跨 Source 可以有同名同路径项目；显式 identity 时不能落到名称匹配的第一行。
    const project = $(
      `[data-project-workspace-identity=${JSON.stringify(options.workspaceIdentity)}]`,
    );
    await project.waitForDisplayed({ timeout: 30_000 });
    await project.moveTo();
    await project.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
  } else {
    await hoverProjectRow(workspacePath);
    await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_CREATE_TASK, {
      timeoutMsg: `项目 ${workspacePath} 没有可用的新建任务入口`,
    });
  }
  // 合并适配：切换项目时退场动画会短暂保留旧输入框；只等导航路径会向旧会话发送。
  // 只统计主 pane；side chat 合法保留自己的输入框，不能要求整个页面只剩一个输入框。
  // 等主 pane 旧输入框移除，再确认目标项目的空草稿，防止向退场会话发送。
  await browser.waitUntil(
    () =>
      browser.execute(
        (
          inputId,
          panePrefix,
          workspaceTriggerId,
          projectName,
          identity,
          key,
          previousVersion,
          shellPrefix,
        ) => {
          // 工作台给每个 Tab 分配稳定 paneId；新建后应检查当前焦点栏，不能继续等待旧 workspace-main。
          const focused = document.querySelector<HTMLElement>(
            `[data-testid^="${shellPrefix}-"][data-focused="true"]`,
          );
          const pane =
            focused?.querySelector<HTMLElement>(`[data-testid^="${panePrefix}-"]`) ??
            document.querySelector<HTMLElement>(`[data-testid="${panePrefix}-workspace-main"]`);
          const inputs = pane?.querySelectorAll(`[data-testid="${inputId}"]`) ?? [];
          const trigger = pane?.querySelector<HTMLElement>(`[data-testid="${workspaceTriggerId}"]`);
          const activeIdentity = identity
            ? (
                window as Window & {
                  __zcodeTabStoreE2E?: {
                    getState(): { activeWorkspaceIdentity?: string | null };
                  };
                }
              ).__zcodeTabStoreE2E?.getState().activeWorkspaceIdentity
            : undefined;
          return (
            // 目录准备是异步的；同项目已经显示草稿时，旧 DOM 不能证明本次新建已提交。
            ((
              window as unknown as {
                __zcodeSessionStoreE2E?: {
                  getState(): { workspaces: Record<string, { draftFocusVersion?: number }> };
                };
              }
            ).__zcodeSessionStoreE2E?.getState().workspaces[key]?.draftFocusVersion ?? 0) >
              previousVersion &&
            (!identity || activeIdentity === identity) &&
            inputs.length === 1 &&
            pane?.dataset.sessionId === "draft" &&
            trigger?.innerText.trim() === projectName
          );
        },
        TID_V4_COMPOSER_INPUT,
        TID_V4_SESSION_PANE,
        TID_COMPOSER_WORKSPACE_TRIGGER,
        projectScope?.projectName ?? projectNameForWorkspace(workspacePath),
        workspaceIdentity,
        draftKey,
        previousDraftVersion,
        TID_V4_PANE_SHELL,
      ),
    { timeout: 30_000, timeoutMsg: `项目 ${workspacePath} 的新任务输入框尚未就绪` },
  );
}

/** 打开项目行更多菜单并选择动作（edit / pin / delete / remove-entry）。 */
export async function openProjectMenuAction(
  workspacePath: string,
  actionId: string,
  { timeout = 30_000 }: WaitOptions = {},
): Promise<void> {
  await hoverProjectRow(workspacePath, timeout);
  // Bug 根因：Radix DropdownMenu trigger 依赖 pointerdown 手势，element.click() 只派发
  // click 时 portal 菜单不会打开；这里补齐指针链。
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, menuTestId) => {
          const trigger = document
            .querySelector(selector)
            ?.querySelector<HTMLButtonElement>(`[data-testid="${menuTestId}"]`);
          if (!trigger || trigger.disabled) return false;
          trigger.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
          trigger.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
          );
          trigger.click();
          return true;
        },
        projectSectionSelector(workspacePath),
        TID_VIRTUAL_PROJECT_MENU,
      ),
    { timeout, timeoutMsg: `项目 ${workspacePath} 没有显示更多菜单入口` },
  );
  const itemTestId = virtualProjectActionTestId(actionId);
  await browser.waitUntil(
    () =>
      browser.execute((targetTestId) => {
        const item = document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`);
        if (!item || item.getAttribute("aria-disabled") === "true") return false;
        item.click();
        return true;
      }, itemTestId),
    { timeout: 15_000, timeoutMsg: `项目 ${workspacePath} 菜单没有 ${actionId} 动作` },
  );
}

export interface ProjectTaskRowState {
  active: boolean;
  error: boolean;
  exists: boolean;
  inProject: boolean;
  running: boolean;
}

/** 读取任务行是否存在于目标项目 section 内及其展示状态。 */
export async function readProjectTaskRowState(
  taskId: string,
  workspacePath: string,
  projectScope?: SidebarProjectScope,
): Promise<ProjectTaskRowState> {
  return browser.execute(
    (taskTestId, sectionSelector, requireUnique) => {
      const sections = document.querySelectorAll(sectionSelector);
      if (requireUnique && sections.length > 1)
        throw new Error(`显式项目必须唯一，实际 ${sections.length}`);
      const section = sections[0];
      // 修复依据：任务只能由已核对身份的项目证明归属，全局首 task 可能属于同名兄弟项目。
      const root = requireUnique ? section : document;
      const taskRows = Array.from(
        root?.querySelectorAll<HTMLElement>("[data-testid]") ?? [],
      ).filter((element) => element.dataset.testid === taskTestId);
      if (requireUnique && taskRows.length > 1)
        throw new Error(`显式项目内任务行必须唯一，实际 ${taskRows.length}`);
      const taskRow = taskRows[0];
      return {
        active: taskRow?.classList.contains("bg-selected") ?? false,
        error: Boolean(taskRow?.querySelector('[data-error-indicator="true"]')),
        exists: Boolean(taskRow),
        inProject: Boolean(taskRow && section?.contains(taskRow)),
        running: Boolean(taskRow?.querySelector(".animate-spin")),
      };
    },
    testId(TID_TASK_ITEM, taskId),
    projectSectionSelector(workspacePath, projectScope),
    Boolean(projectScope),
  );
}

export async function waitForTaskRowInProject(
  taskId: string,
  workspacePath: string,
  {
    timeout = 30_000,
    timeoutMsg = `task ${taskId} 没有出现在项目 ${workspacePath} 下`,
    projectScope,
  }: WaitOptions = {},
): Promise<void> {
  await waitForProjectRow(workspacePath, { timeout, projectScope });
  await browser.waitUntil(
    async () => {
      // 远端项目在离线态下 toggle 被禁用、任务列表不渲染；这里只做尽力展开，
      // 由 task 行本身的出现作为 host 恢复在线且任务归位的判据。
      if (!(await readProjectExpanded(workspacePath, projectScope))) {
        await browser.execute(
          (selector, toggleTestId, requireUnique) => {
            const sections = document.querySelectorAll(selector);
            if (requireUnique && sections.length > 1)
              throw new Error(`显式项目必须唯一，实际 ${sections.length}`);
            const toggle = sections[0]?.querySelector<HTMLButtonElement>(
              `[data-testid="${toggleTestId}"]`,
            );
            if (toggle && !toggle.disabled) toggle.click();
          },
          projectSectionSelector(workspacePath, projectScope),
          TID_VIRTUAL_PROJECT_TOGGLE,
          Boolean(projectScope),
        );
      }
      const state = await readProjectTaskRowState(taskId, workspacePath, projectScope);
      return state.exists && state.inProject && !state.error;
    },
    { timeout, interval: 250, timeoutMsg },
  );
}

/** 远端身份来自项目行，不再存在 Host 包装层。 */
export async function readRemoteHostIdForProject(workspacePath: string): Promise<string | null> {
  return browser.execute(
    (selector) => document.querySelector(selector)?.getAttribute("data-project-host") ?? null,
    projectSectionSelector(workspacePath),
  );
}

/** 设备连接操作位于项目行菜单，仍交给同一个 Host 连接端口。 */
export async function clickRemoteHostConnect(
  workspacePath: string,
  options: WaitOptions = {},
): Promise<void> {
  await openProjectMenuAction(workspacePath, "connect", options);
}

/** 仅替代系统弹窗的用户选择，保留 renderer → preload → main 的真实多目录链路。 */
export async function selectNativeProjectDirectories(paths: string[]) {
  const picker = await browser.electron.mock("dialog", "showOpenDialog");
  try {
    await picker.mockResolvedValueOnce({ canceled: paths.length === 0, filePaths: paths });
    await $('[data-testid="virtual-project-browse"]').click();
    await expect(picker).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    await $('[data-testid="virtual-project-save"]').waitForEnabled();
    expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(false);
    for (const path of paths) {
      await $(
        `[data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}]`,
      ).waitForDisplayed();
    }
  } finally {
    await picker.mockRestore();
  }
}

/** 远程目录由所属 Host 浏览，不借本机系统文件选择器。 */
export async function selectRemoteProjectDirectory(path: string) {
  if (!(await $('[data-testid="virtual-project-directory-browser"]').isDisplayed()))
    await $('[data-testid="virtual-project-browse"]').click();
  const picker = $('[data-testid="virtual-project-directory-browser"]');
  const input = picker.$('input[type="text"]');
  await input.waitForDisplayed();
  await browser.waitUntil(async () => Boolean(await input.getValue()));
  await browser.execute((value) => {
    const element = document.querySelector<HTMLInputElement>(
      '[data-testid="virtual-project-directory-browser"] input[type="text"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, path);
  await input.click();
  await browser.keys("Enter");
  const select = picker.$(
    './/button[normalize-space(.)="选择文件夹" or normalize-space(.)="Choose folder"]',
  );
  await select.waitForEnabled();
  await select.click();
  await picker.waitForExist({ reverse: true });
  await $(
    `[data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}]`,
  ).waitForDisplayed();
}
