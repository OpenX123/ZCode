// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";
vi.mock("@/v4/WorkbenchPane.js", () => ({ WorkbenchLeafPane: () => null }));
vi.mock("@/v4/WorkbenchSplitDivider.js", () => ({ WorkbenchSplitDivider: () => null }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/external-engine/index.js", () => ({ TaskClientLogo: () => null }));
const scope = { workspacePath: "/workspace" };
function reset() {
  cleanup();
  useWorkbenchTabsStore.setState({ groups: [], tabs: {}, focusedGroupId: "", ratio: 0.5 });
}
beforeEach(reset);
afterEach(reset);
describe("工作台焦点同步", () => {
  it("关闭焦点右栏后回到左侧会话，切草稿时同步 null", () => {
    const state = useWorkbenchTabsStore.getState();
    state.initialize(scope, "main-session");
    const left = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    const right = state.splitRight(scope);
    state.bindSession(right, "right-session");
    const onPaneActiveSessionChange = vi.fn();
    render(
      createElement(V4WorkspaceChatArea, {
        ...scope,
        sessionId: "right-session",
        onPaneActiveSessionChange,
      }),
    );
    act(() => state.closeTab(right));
    expect(onPaneActiveSessionChange).toHaveBeenLastCalledWith(scope, "main-session");
    act(() => state.newDraft(scope));
    expect(onPaneActiveSessionChange).toHaveBeenLastCalledWith(scope, null);
    expect(useWorkbenchTabsStore.getState().tabs[left]?.sessionId).toBe("main-session");
  });
  it("只读观察会话不反向改写 shell 当前任务", () => {
    const state = useWorkbenchTabsStore.getState();
    state.initialize(scope, "main-session");
    state.openSession({ workspaceScope: scope, sessionId: "readonly-child", readOnly: true });
    const onPaneActiveSessionChange = vi.fn();
    render(
      createElement(V4WorkspaceChatArea, {
        ...scope,
        sessionId: "main-session",
        onPaneActiveSessionChange,
      }),
    );
    expect(onPaneActiveSessionChange).not.toHaveBeenCalled();
  });
});
