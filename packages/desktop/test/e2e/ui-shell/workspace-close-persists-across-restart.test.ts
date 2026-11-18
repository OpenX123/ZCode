import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_WORKSPACE_PATH } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  seedSettings,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../helpers/e2e-electron-reload.js";
import {
  selectNativeProjectDirectories,
  openProjectMenuAction,
  projectSectionSelector,
  startDraftFromProject,
  waitForProjectRow,
  waitForProjectRowGone,
} from "../helpers/project-sidebar.js";

describe("project removal persists across restart E2E", () => {
  const { homeDir } = getE2EAppDataPaths();
  const closedWorkspacePath = join(homeDir, "ZCodeProjectClosed");
  const draftWorkspacePath = join(homeDir, "ZCodeProjectDraftDeleted");

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    // Windows 上应用退出前仍持有目录句柄（EBUSY）；残留目录不影响结论，不让清理掩盖用例结果。
    for (const path of [closedWorkspacePath, draftWorkspacePath])
      await rm(path, { recursive: true, force: true }).catch(() => {});
  });

  it("WCP01: 删除项目后，完整重启不会被旧 workspace 设置复活", async function () {
    this.timeout(240_000);
    await waitForDefaultWorkspaceReady(30_000);
    await mkdir(closedWorkspacePath, { recursive: true });
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("ZCodeProjectClosed");
    await selectNativeProjectDirectories([closedWorkspacePath]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await waitForProjectRow(closedWorkspacePath);
    const projectId = await $(projectSectionSelector(closedWorkspacePath)).getAttribute(
      "data-project-id",
    );
    await openProjectMenuAction(closedWorkspacePath, "delete");
    await waitForProjectRowGone(closedWorkspacePath);

    const readDeletedProject = () => {
      const db = new DatabaseSync(join(homeDir, ".zcode/v2/tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT project_id, deleted_at FROM projects WHERE project_id=?")
          .get(projectId);
      } finally {
        db.close();
      }
    };
    expect(Number(readDeletedProject()?.deleted_at)).toBeGreaterThan(0);
    // 原因：项目归属由 Host 一次迁移；旧 settings 的目录快照不能在重启时重新生成已删除入口。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedSettings({
          lastWorkspaceSession: [
            { kind: "local", workspacePath: DEFAULT_WORKSPACE },
            { kind: "local", workspacePath: closedWorkspacePath },
          ],
          lastActiveTabIndex: 0,
        });
      },
    });
    await waitForDefaultWorkspaceReady(30_000);
    await waitForProjectRow(DEFAULT_WORKSPACE);
    await waitForProjectRowGone(closedWorkspacePath);
    expect(Number(readDeletedProject()?.deleted_at)).toBeGreaterThan(0);
    // 刷新再触发 renderer 恢复，证明不是仅首帧没显示。
    await browser.refresh();
    await waitForDefaultWorkspaceReady(30_000);
    await waitForProjectRow(DEFAULT_WORKSPACE);
    await waitForProjectRowGone(closedWorkspacePath);
  });

  it("WCP02: 草稿所在项目被删除后回到未选项目，预热不再报 project.deleted", async function () {
    this.timeout(240_000);
    // waitForDefaultWorkspaceReady 要求默认草稿归属 ZCodeProject，main 上 WCP01 已因此基线失败；
    // 本用例只需要主界面就绪，沿用走马灯 spec 已验证的 waitForWorkspaceApp。
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await mkdir(draftWorkspacePath, { recursive: true });
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("ZCodeProjectDraftDeleted");
    await selectNativeProjectDirectories([draftWorkspacePath]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await waitForProjectRow(draftWorkspacePath);
    const projectId = await $(projectSectionSelector(draftWorkspacePath)).getAttribute(
      "data-project-id",
    );
    await startDraftFromProject(draftWorkspacePath);
    const readDraftProjectId = () =>
      browser.execute((key) => {
        const bridge = (
          window as unknown as {
            __zcodeSessionStoreE2E?: {
              getState(): { workspaces: Record<string, { draftProjectId?: string | null }> };
            };
          }
        ).__zcodeSessionStoreE2E;
        return bridge?.getState().workspaces[key]?.draftProjectId ?? null;
      }, draftWorkspacePath);
    await browser.waitUntil(async () => (await readDraftProjectId()) === projectId, {
      timeout: 15_000,
      timeoutMsg: "草稿未归属新建项目",
    });

    await openProjectMenuAction(draftWorkspacePath, "delete");
    await waitForProjectRowGone(draftWorkspacePath);
    // 回归：已删项目 ID 曾残留在草稿上，预热 createSession 被 Host 拒为 project.deleted。
    await browser.waitUntil(async () => (await readDraftProjectId()) === null, {
      timeout: 15_000,
      timeoutMsg: "项目删除后草稿仍保留已删项目 ID",
    });
    const header = await $(`[data-workbench-project][data-testid="${TID_WORKSPACE_PATH}"]`);
    await browser.waitUntil(async () => (await header.getText()).includes("选择项目"), {
      timeout: 15_000,
      timeoutMsg: "草稿栏头未回到「选择项目」",
    });
    // 预热按新归属重建后不得再出现已删项目错误；负向断言需覆盖一次完整重建窗口。
    const sawDeletedError = await browser
      .waitUntil(
        () => browser.execute(() => document.body.innerText.includes("project.deleted")),
        { timeout: 8_000, interval: 500 },
      )
      .catch(() => false);
    expect(sawDeletedError).toBe(false);
  });
});
