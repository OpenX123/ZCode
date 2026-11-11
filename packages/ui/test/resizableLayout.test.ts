// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  defaultLayout: undefined as Record<string, number> | undefined,
  onLayoutChange: vi.fn(),
  groupProps: {} as Record<string, any>,
}));
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({
    defaultLayout: state.defaultLayout,
    onLayoutChange: state.onLayoutChange,
  }),
  Group: (props: Record<string, any>) => {
    state.groupProps = props;
    return null;
  },
  Panel: () => null,
  Separator: () => null,
}));
import { ResizablePanelGroup } from "@/components/ui/resizable.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.defaultLayout = undefined;
});

describe("分栏布局持久化边界", () => {
  it.each([
    { preview: 0, directory: 0 },
    { preview: Number.NaN, directory: 100 },
    { preview: Number.POSITIVE_INFINITY, directory: 0 },
    { preview: -10, directory: 110 },
  ])("忽略不可用的旧布局 %j", (layout) => {
    state.defaultLayout = layout;
    render(createElement(ResizablePanelGroup, { layoutId: "file-manager-layout" }));
    expect(state.groupProps.defaultLayout).toBeUndefined();
  });

  it("隐藏标签页的全零布局不得覆盖已保存的可见布局", () => {
    render(createElement(ResizablePanelGroup, { layoutId: "file-manager-layout" }));
    state.groupProps.onLayoutChange({ preview: 0, directory: 0 });
    expect(state.onLayoutChange).not.toHaveBeenCalled();
  });

  it.each([
    { preview: 100, directory: 0 },
    { preview: 0, directory: 100 },
    { preview: 60, directory: 40 },
  ])("保留合法的显式收起和分栏布局 %j", (layout) => {
    state.defaultLayout = layout;
    render(createElement(ResizablePanelGroup, { layoutId: "file-manager-layout" }));
    expect(state.groupProps.defaultLayout).toEqual(layout);
    state.groupProps.onLayoutChange(layout);
    expect(state.onLayoutChange).toHaveBeenCalledWith(layout);
  });
});
