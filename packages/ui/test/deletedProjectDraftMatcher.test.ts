import { beforeEach, describe, expect, it } from "vitest";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import {
  deletedProjectDraftMatcher,
  releaseDeletedProjectDrafts,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getFocusedWorkbenchTab, useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

describe("已删项目草稿归属判定", () => {
  it("无删除事实时不产生判定，避免无谓释放", () => {
    expect(deletedProjectDraftMatcher([{ id: "a", hostId: "local", deleted: false }])).toBeNull();
    expect(deletedProjectDraftMatcher([])).toBeNull();
  });

  it("按 Host + project 精确匹配，本地与远端同 ID 互不误伤", () => {
    const remoteHost = "remote:server:source";
    const remoteKey = buildRemoteHostWorkspaceIdentity(remoteHost, "/srv/app");
    const local = deletedProjectDraftMatcher([
      { id: "p1", hostId: "local", deleted: true },
      { id: "p2", hostId: remoteHost, deleted: false },
    ])!;
    expect(local("p1", "/project")).toBe(true);
    expect(local("p1", remoteKey)).toBe(false);
    expect(local("p2", remoteKey)).toBe(false);

    const remote = deletedProjectDraftMatcher([{ id: "p1", hostId: remoteHost, deleted: true }])!;
    expect(remote("p1", remoteKey)).toBe(true);
    expect(remote("p1", "/project")).toBe(false);
  });
});

describe("已删项目草稿归属释放", () => {
  const scope = { workspacePath: "/project" };
  beforeEach(() => {
    useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
    useZCodeSessionStore.setState((state) => ({ ...state, workspaces: {} }));
  });

  it("工作台草稿原地改选为未选项目，保留 Tab 身份、焦点与已绑定会话", () => {
    const workbench = useWorkbenchTabsStore.getState();
    workbench.initialize(scope, null, { projectId: "gone", taskGroupId: "g1" });
    const draft = getFocusedWorkbenchTab(useWorkbenchTabsStore.getState())!;
    const alive = workbench.splitRight(scope, { projectId: "alive" });
    const bound = workbench.newDraft(scope, { projectId: "gone" });
    workbench.bindSession(bound, "s-bound");
    const focusedGroupId = useWorkbenchTabsStore.getState().focusedGroupId;

    releaseDeletedProjectDrafts((projectId) => projectId === "gone");

    const state = useWorkbenchTabsStore.getState();
    expect(state.tabs[draft.id]).toMatchObject({
      id: draft.id,
      draftId: draft.draftId,
      projectId: null,
      taskGroupId: null,
    });
    expect(state.tabs[alive]?.projectId).toBe("alive");
    // 已发送会话的归属在 Host，草稿释放不能改写。
    expect(state.tabs[bound]?.projectId).toBe("gone");
    expect(state.focusedGroupId).toBe(focusedGroupId);
  });
});
