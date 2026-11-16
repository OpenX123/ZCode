import { describe, expect, it } from "vitest";
import { createWorkbenchTabsStore, getFocusedWorkbenchTab } from "@/v4/workbench-tabs/index.js";

const scope = { workspacePath: "/project" };
function fixture() {
  let next = 0;
  return createWorkbenchTabsStore({ storage: null, createId: () => `id-${++next}` });
}

describe("工作台草稿改选与批量移动状态转换", () => {
  it("单会话显式右移只发一次完整快照，保留原绑定与独立左草稿", () => {
    const store = fixture();
    const remote = {
      ...scope,
      workspaceIdentity: "ssh://one/project",
      remoteSessionId: "endpoint",
    };
    store.getState().initialize(remote, "session", { projectId: "project", taskGroupId: "group" });
    const original = getFocusedWorkbenchTab(store.getState())!;
    const snapshots: Array<ReturnType<typeof store.getState>> = [];
    store.subscribe((state) => snapshots.push(state));
    store.getState().openSession(original, "right");
    expect(snapshots).toHaveLength(1);
    const after = snapshots[0]!;
    expect(after.groups).toHaveLength(2);
    expect(after.groups.every((group) => group.tabIds.includes(group.activeTabId))).toBe(true);
    expect(after.tabs[original.id]).toBe(original);
    expect(after.tabs[after.groups[0]!.activeTabId]).toMatchObject({
      sessionId: null,
      workspaceScope: remote,
      projectId: "project",
      taskGroupId: "group",
    });
    expect(Object.values(after.tabs).filter((tab) => tab.sessionId === "session")).toHaveLength(1);
  });
  it("原地改选草稿项目保留输入身份、栏位和焦点，不改写其他本地或SSH视图", () => {
    const store = fixture();
    store.getState().initialize(scope, null, { projectId: "old", taskGroupId: "old-group" });
    const draft = getFocusedWorkbenchTab(store.getState())!;
    const rightId = store.getState().splitRight(scope);
    const before = store.getState();
    const remote = { ...scope, workspaceIdentity: "ssh:new", remoteSessionId: "endpoint" };
    const result = store.getState().newDraft(remote, {
      replaceDraftTabId: draft.id,
      projectId: "new",
      taskGroupId: null,
    });
    const after = store.getState();
    expect(result).toBe(draft.id);
    expect(after.groups).toBe(before.groups);
    expect(after.focusedGroupId).toBe(before.focusedGroupId);
    expect(after.tabs[rightId]).toBe(before.tabs[rightId]);
    expect(after.tabs[draft.id]).toEqual({
      ...draft,
      workspaceScope: remote,
      projectId: "new",
      taskGroupId: null,
    });
    let updates = 0;
    store.subscribe(() => updates++);
    store.getState().newDraft(remote, {
      replaceDraftTabId: draft.id,
      projectId: "new",
      taskGroupId: null,
    });
    expect(updates).toBe(0);
  });
  it("原地改选的草稿已发送或不存在时不创建视图，也不修改会话归属", () => {
    const store = fixture();
    store.getState().initialize(scope);
    const draft = getFocusedWorkbenchTab(store.getState())!;
    store.getState().bindSession(draft.id, "accepted");
    const before = store.getState();
    let updates = 0;
    store.subscribe(() => updates++);
    for (const id of [draft.id, "missing"]) {
      expect(
        store.getState().newDraft(
          { workspacePath: "/another" },
          {
            replaceDraftTabId: id,
            projectId: "new",
          },
        ),
      ).toBe(id);
    }
    expect(store.getState()).toBe(before);
    expect(updates).toBe(0);
  });
  it("批量移动的空输入、重复、未知或无归属来源和非法目标均不提交部分状态", () => {
    const store = fixture();
    store.getState().initialize(scope, "left");
    const left = getFocusedWorkbenchTab(store.getState())!.id;
    const right = store.getState().splitRight(scope);
    const target = store.getState().groups[1]!;
    store.setState((state) => ({
      tabs: { ...state.tabs, orphan: { ...state.tabs[left]!, id: "orphan" } },
    }));
    const before = store.getState();
    let updates = 0;
    store.subscribe(() => updates++);
    for (const ids of [[], [left, "missing"], [left, left], [left, "orphan"]]) {
      store.getState().moveTab(ids, target.id, 0, { preserveTargetActive: true });
    }
    store.getState().moveTab([left, right], "missing-group", 0);
    expect(store.getState()).toBe(before);
    expect(updates).toBe(0);
  });
  it("批量移动默认激活首个输入Tab，移除源后的插入顺序稳定", () => {
    const store = fixture();
    store.getState().initialize(scope, "a");
    const a = getFocusedWorkbenchTab(store.getState())!.id;
    const b = store.getState().openSession({ workspaceScope: scope, sessionId: "b" });
    const c = store.getState().openSession({ workspaceScope: scope, sessionId: "c" });
    const group = store.getState().groups[0]!;
    store.getState().moveTab([c, a], group.id, 1);
    expect(store.getState().groups[0]).toEqual({ ...group, tabIds: [b, c, a], activeTabId: c });
  });
});
