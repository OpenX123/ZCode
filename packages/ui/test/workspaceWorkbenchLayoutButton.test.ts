// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorkbenchLayoutButton } from "@/project-sidebar/WorkbenchLayoutButton.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => null,
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: import("react").ReactNode }) => children,
}));

const scope = { workspacePath: "/project" };
beforeEach(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
  useWorkbenchTabsStore.getState().initialize(scope, "session-a");
});
afterEach(cleanup);
function setup() {
  const view = render(createElement(WorkspaceWorkbenchLayoutButton));
  const menu = () =>
    fireEvent.pointerDown(view.getByTestId("workbench-layout-menu"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
  return { ...view, menu };
}

describe("右上工作台布局入口", () => {
  it("单一图标菜单分栏创建独立草稿，交换不改变视图身份", () => {
    const view = setup();
    const leftId = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    view.menu();
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const rightId = useWorkbenchTabsStore.getState().groups[1]!.activeTabId;
    expect(useWorkbenchTabsStore.getState().tabs[rightId]?.draftId).toBe(rightId);
    view.menu();
    fireEvent.click(view.getByTestId("workbench-swap-groups"));
    expect(useWorkbenchTabsStore.getState().groups.map((group) => group.activeTabId)).toEqual([
      rightId,
      leftId,
    ]);
  });

  it("合栏保留全部草稿，隐藏草稿可通过布局菜单重新激活", () => {
    const view = setup();
    view.menu();
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const original = useWorkbenchTabsStore.getState();
    const leftActive = original.groups[0]!.activeTabId;
    const firstDraft = original.groups[1]!.activeTabId;
    let secondDraft = "";
    act(() => {
      secondDraft = useWorkbenchTabsStore.getState().newDraft(scope);
    });
    view.menu();
    fireEvent.click(view.getByTestId("workbench-merge-groups"));
    expect(useWorkbenchTabsStore.getState().groups).toHaveLength(1);
    expect(Object.keys(useWorkbenchTabsStore.getState().tabs)).toHaveLength(3);
    expect(useWorkbenchTabsStore.getState().groups[0]!.activeTabId).toBe(leftActive);
    expect(useWorkbenchTabsStore.getState().focusedGroupId).toBe(original.groups[0]!.id);
    view.menu();
    fireEvent.click(view.getByTestId(`workbench-activate-tab-${firstDraft}`));
    expect(useWorkbenchTabsStore.getState().groups[0]!.activeTabId).toBe(firstDraft);
    view.menu();
    fireEvent.click(view.getByTestId("workbench-close-view"));
    expect(useWorkbenchTabsStore.getState().tabs[firstDraft]).toBeUndefined();
    expect(useWorkbenchTabsStore.getState().tabs[secondDraft]).toBeTruthy();
  });

  it("草稿移动到另一栏后自动合栏，保留原来的会话绑定", () => {
    const view = setup();
    view.menu();
    fireEvent.click(view.getByTestId("workbench-split-right"));
    const state = useWorkbenchTabsStore.getState();
    const leftId = state.groups[0]!.activeTabId;
    const rightId = state.groups[1]!.activeTabId;
    view.menu();
    fireEvent.click(view.getByTestId("workbench-move-to-other-group"));
    expect(useWorkbenchTabsStore.getState().groups[0]!.tabIds).toEqual([leftId, rightId]);
    expect(useWorkbenchTabsStore.getState().tabs[leftId]?.sessionId).toBe("session-a");
    expect(useWorkbenchTabsStore.getState().tabs[rightId]?.sessionId).toBeNull();
  });
});
