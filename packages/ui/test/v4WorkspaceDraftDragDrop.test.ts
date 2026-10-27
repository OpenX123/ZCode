// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  leafPaneIds,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { WorkbenchLeafPaneProps } from "@/v4/WorkbenchPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useWorkbenchTabsStore } from "@/v4/workbench-tabs/index.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/external-engine/index.js", () => ({ TaskClientLogo: () => null }));

const leafPaneCapture = vi.hoisted(() => ({
  props: [] as WorkbenchLeafPaneProps[],
}));

vi.mock("@/v4/WorkbenchPane.js", async () => {
  const React = await import("react");
  return {
    WorkbenchLeafPane: (props: WorkbenchLeafPaneProps) => {
      leafPaneCapture.props.push(props);
      return React.createElement("div", {
        "data-pane-id": props.paneId,
      });
    },
  };
});

vi.mock("@/v4/WorkbenchSplitDivider.js", async () => {
  const React = await import("react");
  return {
    WorkbenchSplitDivider: () => React.createElement("div", { "data-testid": "mock-divider" }),
  };
});

function resetWorkbenchState(): void {
  cleanup();
  usePaneLayoutStore.setState({
    root: INITIAL_PANE_LAYOUT.root,
    panes: INITIAL_PANE_LAYOUT.panes,
    focusedPaneId: INITIAL_PANE_LAYOUT.focusedPaneId,
  });
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  useWorkbenchTabsStore.setState({
    groups: [],
    tabs: {},
    focusedGroupId: "",
    ratio: 0.5,
  });
  leafPaneCapture.props = [];
}

describe("V4WorkspaceChatArea split entries", () => {
  beforeEach(resetWorkbenchState);
  afterEach(resetWorkbenchState);

  // 对话区不再提供额外 Tab 栏；布局操作经侧栏右键与壳层工具栏进入。
  it("leaves layout controls to the sidebar and header without reserving a tab row", () => {
    useWorkbenchTabsStore.getState().initialize({ workspacePath: "/workspace" }, null);
    const tabId = useWorkbenchTabsStore.getState().groups[0]!.activeTabId;
    const view = render(
      createElement(V4WorkspaceChatArea, {
        sessionId: null,
        workspacePath: "/workspace",
        isDesktop: true,
      }),
    );

    const primaryPane = leafPaneCapture.props[0];
    expect(primaryPane?.paneId).toBe(tabId);
    expect(view.queryByRole("tablist")).toBeNull();
    expect(view.queryByTestId("workbench-split-right")).toBeNull();
    expect(primaryPane?.rect).toEqual({ left: "0%", top: "0%", width: "100%", height: "100%" });
    expect("canDropSession" in primaryPane!).toBe(false);
    expect("onDropSession" in primaryPane!).toBe(false);
    expect("onSplit" in primaryPane!).toBe(false);
    expect("canSplit" in primaryPane!).toBe(false);
    expect(leafPaneIds(usePaneLayoutStore.getState().root)).toEqual([V4_PRIMARY_PANE_ID]);
  });
});
