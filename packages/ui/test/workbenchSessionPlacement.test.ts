import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { getFocusedWorkbenchTab, useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";
import { selectWorkbenchSession } from "@/v4/workbenchSessionPlacement.js";
const scope = { workspacePath: "/workspace" };
function reset() {
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
  usePaneLayoutStore.setState(INITIAL_PANE_LAYOUT);
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
}
beforeEach(reset);
afterEach(reset);
describe("侧栏会话放置", () => {
  it("消费旧 draft 分屏，在当前栏新增 Tab 并保留原会话", () => {
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: scope,
      sessionId: "session-b",
    });
    selectWorkbenchSession(null, { ...scope, sessionId: "session-c" });
    const state = useWorkbenchTabsStore.getState();
    expect(Object.values(state.tabs).map((tab) => tab.sessionId)).toEqual([
      null,
      "session-b",
      "session-c",
    ]);
    expect(usePaneLayoutStore.getState().panes).toEqual({});
    expect(getFocusedWorkbenchTab(state)?.sessionId).toBe("session-c");
  });
  it("已在另一栏打开时聚焦原位置，不增加重复会话", () => {
    const state = useWorkbenchTabsStore.getState();
    state.initialize(scope, "session-a");
    const originalGroupId = state.groups[0]?.id ?? useWorkbenchTabsStore.getState().groups[0]!.id;
    state.splitRight(scope);
    selectWorkbenchSession(
      { workspaceScope: scope, sessionId: "session-a" },
      { ...scope, sessionId: "session-a" },
    );
    expect(useWorkbenchTabsStore.getState().focusedGroupId).toBe(originalGroupId);
    expect(
      Object.values(useWorkbenchTabsStore.getState().tabs).filter(
        (tab) => tab.sessionId === "session-a",
      ),
    ).toHaveLength(1);
  });
});
