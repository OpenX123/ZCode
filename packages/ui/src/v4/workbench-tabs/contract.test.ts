import { describe, expect, it } from "vitest";
import { getFocusedWorkbenchTab, workbenchWorkspaceKey } from "./contract.js";
import { conversationWorkbenchModule } from "./module.js";
import { createWorkbenchTabsStore, WORKBENCH_TABS_STORAGE_KEY } from "./store.js";

const scope = { workspacePath: "/project" };
function fixture() {
  let next = 0;
  return createWorkbenchTabsStore({ storage: null, createId: () => `id-${++next}` });
}

describe("双栏工作台契约", () => {
  it("声明模块与远端身份隔离", () => {
    expect(conversationWorkbenchModule.id).toBe("conversation-workbench");
    expect(workbenchWorkspaceKey({ ...scope, workspaceIdentity: " remote " })).toBe("remote");
  });
  it("同项目两份草稿身份独立，accepted 不改变原 Tab", () => {
    const store = fixture();
    store.getState().initialize(scope, null, { projectId: "project-a" });
    const first = getFocusedWorkbenchTab(store.getState())!;
    const right = store.getState().splitRight(scope, { projectId: "project-a" });
    expect(store.getState().groups).toHaveLength(2);
    expect(store.getState().tabs[right]?.draftId).not.toBe(first.draftId);
    store.getState().bindSession(right, "s-right");
    expect(store.getState().tabs[right]).toMatchObject({ id: right, sessionId: "s-right" });
    expect(store.getState().tabs[first.id]?.sessionId).toBeNull();
  });
  it("侧栏打开另一栏已有会话只聚焦，远端同路径不同 identity 可并存", () => {
    const store = fixture();
    store.getState().initialize(scope, "s1");
    const existing = getFocusedWorkbenchTab(store.getState())!;
    store.getState().splitRight(scope);
    expect(store.getState().openSession({ workspaceScope: scope, sessionId: "s1" })).toBe(
      existing.id,
    );
    expect(getFocusedWorkbenchTab(store.getState())?.id).toBe(existing.id);
    const remote = store.getState().openSession({
      workspaceScope: { ...scope, workspaceIdentity: "ssh:b", remoteSessionId: "r" },
      sessionId: "s1",
    });
    expect(remote).not.toBe(existing.id);
  });
  it("侧栏定向打开新会话原子建立右栏，不产生临时草稿或改写左栏", () => {
    const store = fixture();
    store.getState().initialize(scope, "left-session");
    const left = store.getState().groups[0]!;
    const snapshots: number[] = [];
    store.subscribe((state) => snapshots.push(Object.keys(state.tabs).length));
    const id = store
      .getState()
      .openSession({ workspaceScope: scope, sessionId: "right-session" }, "right");
    expect(store.getState().groups[0]).toEqual(left);
    expect(store.getState().groups[1]?.activeTabId).toBe(id);
    expect(snapshots).toEqual([2]);
    expect(Object.values(store.getState().tabs).every((tab) => tab.sessionId)).toBe(true);
  });
  it("唯一会话在右栏打开保留稳定身份，原左栏仅新建一个独立草稿", () => {
    const store = fixture();
    store.getState().initialize(scope, "session", {
      projectId: "project",
      taskGroupId: "group",
      inheritRootDraft: true,
    });
    const original = getFocusedWorkbenchTab(store.getState())!;
    const id = store
      .getState()
      .openSession({ workspaceScope: scope, sessionId: "session" }, "right");
    expect(id).toBe(original.id);
    expect(store.getState().tabs[id]).toBe(original);
    expect(store.getState().groups[1]?.activeTabId).toBe(id);
    const left = store.getState().tabs[store.getState().groups[0]!.activeTabId]!;
    expect(left.sessionId).toBeNull();
    expect(left.draftId).not.toBe(id);
    expect(left).toMatchObject({ projectId: "project", taskGroupId: "group" });
    expect(left.inheritRootDraft).toBeUndefined();
    expect(Object.keys(store.getState().tabs)).toHaveLength(2);
  });
  it("定向移动已打开会话保留目标其余会话、完整远端身份和空栏合并规则", () => {
    const store = fixture();
    store.getState().initialize(scope, "same-id");
    const local = getFocusedWorkbenchTab(store.getState())!;
    const remoteScope = { ...scope, workspaceIdentity: "ssh:other", remoteSessionId: "endpoint" };
    const remote = store
      .getState()
      .openSession({ workspaceScope: remoteScope, sessionId: "same-id" }, "right");
    store.getState().openSession({ workspaceScope: remoteScope, sessionId: "same-id" }, "left");
    expect(store.getState().groups).toHaveLength(1);
    expect(store.getState().groups[0]?.tabIds).toEqual([local.id, remote]);
    expect(store.getState().tabs[local.id]).toBe(local);
    expect(store.getState().tabs[remote]?.workspaceScope).toEqual(remoteScope);
  });
  it("SSH连接换代刷新前后台会话和草稿，保留布局与稳定身份且隔离同路径Source", () => {
    const store = fixture();
    const oldScope = { ...scope, workspaceIdentity: "ssh:one", remoteSessionId: "endpoint-old" };
    store.getState().initialize(oldScope, "session-a");
    const sessionA = getFocusedWorkbenchTab(store.getState())!;
    const sessionB = store
      .getState()
      .openSession({ workspaceScope: oldScope, sessionId: "session-b" });
    const draft = store.getState().splitRight(oldScope);
    const other = store.getState().openSession({
      workspaceScope: { ...oldScope, workspaceIdentity: "ssh:other" },
      sessionId: "session-other",
    });
    const local = store.getState().openSession({ workspaceScope: scope, sessionId: "local" });
    const before = store.getState();
    store.getState().refreshWorkspaceScope({ ...oldScope, remoteSessionId: "endpoint-new" });
    const after = store.getState();
    expect(after.groups).toBe(before.groups);
    expect(after.focusedGroupId).toBe(before.focusedGroupId);
    for (const id of [sessionA.id, sessionB, draft]) {
      expect(after.tabs[id]).toMatchObject({
        id,
        workspaceScope: { remoteSessionId: "endpoint-new" },
      });
      expect(after.tabs[id]!.sessionId).toBe(before.tabs[id]!.sessionId);
      expect(after.tabs[id]!.draftId).toBe(before.tabs[id]!.draftId);
    }
    expect(after.tabs[other]).toBe(before.tabs[other]);
    expect(after.tabs[local]).toBe(before.tabs[local]);
    store.getState().refreshWorkspaceScope({ ...scope, workspaceIdentity: "ssh:one" });
    expect(store.getState().tabs[draft]!.workspaceScope.remoteSessionId).toBe("endpoint-new");
    store.getState().refreshWorkspaceScope({ ...scope, remoteSessionId: "local-only" });
    expect(store.getState().tabs[draft]!.workspaceScope.remoteSessionId).toBe("endpoint-new");
  });
  it("重新打开同identity已有会话同步刷新同工作区后台Tab连接", () => {
    const store = fixture();
    const oldScope = { ...scope, workspaceIdentity: "ssh:one", remoteSessionId: "endpoint-old" };
    store.getState().initialize(oldScope, "session-a");
    const session = getFocusedWorkbenchTab(store.getState())!;
    const draft = store.getState().splitRight(oldScope);
    expect(
      store.getState().openSession({
        workspaceScope: { ...oldScope, remoteSessionId: "endpoint-new" },
        sessionId: "session-a",
      }),
    ).toBe(session.id);
    expect(store.getState().tabs[draft]!.workspaceScope.remoteSessionId).toBe("endpoint-new");
    store.getState().openSession({
      workspaceScope: { ...scope, workspaceIdentity: "ssh:one" },
      sessionId: "session-a",
    });
    expect(store.getState().tabs[session.id]!.workspaceScope.remoteSessionId).toBe("endpoint-new");
  });
  it("恢复的同会话绑定只确认有效性，不更换Tab或布局", () => {
    const store = fixture();
    store
      .getState()
      .openSession({ workspaceScope: scope, sessionId: "restored", restoredUnvalidated: true });
    const tab = getFocusedWorkbenchTab(store.getState())!;
    const groups = store.getState().groups;
    store.getState().bindSession(tab.id, "restored");
    expect(store.getState().tabs[tab.id]).toMatchObject({
      id: tab.id,
      sessionId: "restored",
      restoredUnvalidated: false,
    });
    expect(store.getState().groups).toBe(groups);
  });
  it("跨栏移动保留目标 Tab，空源栏合并，交换不改变 Tab 对象", () => {
    const store = fixture();
    store.getState().initialize(scope, "s1");
    const first = getFocusedWorkbenchTab(store.getState())!;
    store.getState().splitRight(scope);
    const target = store.getState().groups[1]!;
    const rightTab = store.getState().tabs[target.activeTabId];
    store.getState().swapGroups();
    expect(store.getState().groups[0]?.id).toBe(target.id);
    store.getState().moveTab(first.id, target.id, 0);
    expect(store.getState().groups).toHaveLength(1);
    expect(store.getState().groups[0]?.tabIds).toEqual([first.id, rightTab!.id]);
    expect(store.getState().tabs[first.id]).toBe(first);
    expect(store.getState().tabs[rightTab!.id]).toBe(rightTab);
  });
  it("同栏排序不丢失页签，关闭最后一页回独立草稿而不改变原 scope", () => {
    const store = fixture();
    store.getState().initialize(scope, "s1");
    const first = getFocusedWorkbenchTab(store.getState())!;
    const second = store.getState().openSession({ workspaceScope: scope, sessionId: "s2" });
    const group = store.getState().groups[0]!;
    store.getState().moveTab(first.id, group.id, 1);
    expect(store.getState().groups[0]?.tabIds).toEqual([second, first.id]);
    store.getState().closeTab(first.id);
    store.getState().closeTab(second);
    const draft = getFocusedWorkbenchTab(store.getState())!;
    expect(draft.sessionId).toBeNull();
    expect(draft.workspaceScope).toEqual(scope);
    expect(draft.id).not.toBe(second);
  });
  it.each(["left", "right"])("关闭%s栏一次合入所有前后台视图和草稿，保留目标当前会话", (side) => {
    const store = fixture();
    store.getState().initialize(scope, "left-hidden");
    store.getState().newDraft(scope, { projectId: "left-project" });
    store.getState().openSession({ workspaceScope: scope, sessionId: "left-active" });
    const remoteScope = { ...scope, workspaceIdentity: "ssh:other", remoteSessionId: "endpoint" };
    store.getState().splitRight(remoteScope, { projectId: "right-project", taskGroupId: "group" });
    store.getState().openSession({ workspaceScope: remoteScope, sessionId: "right-hidden" });
    store.getState().openSession({ workspaceScope: remoteScope, sessionId: "right-active" });
    const before = store.getState();
    const source = before.groups[side === "left" ? 0 : 1]!;
    const target = before.groups[side === "left" ? 1 : 0]!;
    store.getState().activateTab(source.activeTabId);
    const snapshots: string[][] = [];
    store.subscribe((state) => snapshots.push(state.groups.map((group) => group.id)));

    store.getState().moveTab(source.tabIds, target.id, target.tabIds.length, {
      preserveTargetActive: true,
    });

    const after = store.getState();
    expect(snapshots).toEqual([[target.id]]);
    expect(after.groups).toEqual([{ ...target, tabIds: [...target.tabIds, ...source.tabIds] }]);
    expect(after.focusedGroupId).toBe(target.id);
    expect(after.tabs).toBe(before.tabs);
    for (const id of [...source.tabIds, ...target.tabIds]) {
      expect(after.tabs[id]).toBe(before.tabs[id]);
    }
    expect(Object.values(after.tabs).filter((tab) => tab.draftId)).toHaveLength(2);
  });
  it("同栏三页拖拽使用移除源后的最终索引，前移和后移均保留其余顺序", () => {
    const store = fixture();
    store.getState().initialize(scope, "a");
    const a = getFocusedWorkbenchTab(store.getState())!.id;
    const b = store.getState().openSession({ workspaceScope: scope, sessionId: "b" });
    const c = store.getState().openSession({ workspaceScope: scope, sessionId: "c" });
    const groupId = store.getState().groups[0]!.id;
    store.getState().moveTab(a, groupId, 1);
    expect(store.getState().groups[0]!.tabIds).toEqual([b, a, c]);
    store.getState().moveTab(c, groupId, 0);
    expect(store.getState().groups[0]!.tabIds).toEqual([c, b, a]);
    store.getState().moveTab(c, groupId, 2);
    expect(store.getState().groups[0]!.tabIds).toEqual([b, a, c]);
  });
  it("持久化恢复保持布局与草稿指针，不执行任何会话命令", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const store = createWorkbenchTabsStore({ storage });
    store.getState().initialize(scope, "s1");
    const draft = store.getState().splitRight(scope);
    store.getState().setRatio(0.6);
    expect(values.has(WORKBENCH_TABS_STORAGE_KEY)).toBe(true);
    const restored = createWorkbenchTabsStore({ storage }).getState();
    expect(restored.groups).toEqual(store.getState().groups);
    expect(restored.tabs[draft]?.draftId).toBe(store.getState().tabs[draft]?.draftId);
    expect(restored.ratio).toBe(0.6);
    expect(
      Object.values(restored.tabs).find((tab) => tab.sessionId === "s1")?.restoredUnvalidated,
    ).toBe(true);
  });
  it("旧四 pane 迁为左右 Tab，草稿保留，迁移幂等", () => {
    const store = fixture();
    const bindings = ["s1", "s2", null, "s3"].map((sessionId) => ({
      workspaceScope: scope,
      sessionId,
    }));
    store.getState().migrateLegacy(bindings, 0.55);
    expect(store.getState().groups.map((group) => group.tabIds.length)).toEqual([1, 3]);
    expect(
      Object.values(store.getState().tabs).find((tab) => tab.sessionId === null)?.draftId,
    ).toBeTruthy();
    const before = store.getState().groups;
    store.getState().migrateLegacy(bindings);
    expect(store.getState().groups).toBe(before);
  });
});
