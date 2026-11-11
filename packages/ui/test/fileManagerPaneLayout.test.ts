// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  observer: null as null | ResizeObserverCallback,
  preview: { collapse: vi.fn(), expand: vi.fn() },
  directory: { collapse: vi.fn(), expand: vi.fn() },
  saved: vi.fn(),
}));
vi.mock("react-resizable-panels", () => {
  let index = 0;
  return { usePanelRef: () => ({ current: index++ % 2 === 0 ? state.preview : state.directory }) };
});
vi.mock("@/components/ui/resizable.js", () => ({
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME: "",
  ResizablePanelGroup: ({ children }: any) => createElement("div", null, children),
  ResizablePanel: ({ children }: any) => createElement("div", null, children),
  ResizableHandle: () => null,
}));
vi.mock("@/PreviewPane.js", () => ({ PreviewPane: () => createElement("div", null, "正文") }));
vi.mock("@/workspace-file-tree/WorkspaceFileTree.js", () => ({ WorkspaceFileTree: () => null }));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (select: any) =>
    select({ fileManagerNavigationOpenByWorkspace: {}, setFileManagerNavigationOpen: state.saved }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: any) => id } }),
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(callback: ResizeObserverCallback) {
      state.observer = callback;
    }
    observe() {}
    disconnect() {}
  },
);
import { FileManagerPane } from "@/WorkspaceFileTree.js";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("文件预览窄栏布局", () => {
  it.each(["readme.md", "example.py"])("直接打开%s时展示正文而非零宽预览", (path) => {
    render(
      createElement(FileManagerPane, {
        source: { type: "file", path: `/repo/${path}`, title: path },
        target: { workspacePath: "/repo" },
        mobileOverlay: false,
        canOpenLocalFileManager: true,
        onNavigate: vi.fn(),
      } as any),
    );
    state.preview.collapse.mockClear();
    state.preview.expand.mockClear();
    state.directory.collapse.mockClear();
    act(() =>
      state.observer?.(
        [{ contentRect: { width: 300 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(state.preview.collapse).not.toHaveBeenCalled();
    expect(state.preview.expand).toHaveBeenCalled();
    expect(state.directory.collapse).toHaveBeenCalled();
    expect(state.saved).not.toHaveBeenCalled();
  });
});
