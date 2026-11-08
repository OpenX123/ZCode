// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";

type TestTab =
  | {
      id: string;
      kind: "workspace";
      workspacePath: string;
      label: string;
      workspaceIdentity?: string;
    }
  | { id: "__settings__"; kind: "settings"; label: "settings" };

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [] as unknown[],
  sessionState: {
    workspaces: {} as Record<string, { taskListVersion: number }>,
    removeTaskState: () => {},
  },
  read: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: { tabs: unknown[] }) => unknown) => select({ tabs: mocks.tabs }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: (state: typeof mocks.sessionState) => unknown) =>
    select(mocks.sessionState),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/useProjectUnreadSignals.js", () => ({
  useProjectUnreadSignals: () => {},
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.read(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function workspaceTab(path: string, label: string): TestTab {
  return { id: `tab:${path}`, kind: "workspace", workspacePath: path, label };
}

/**
 * P12（2026-11-08 扫描）：readDirectory 190 次/天、readTree 96 次/天。读取 effect 依赖整个 tabs 数组
 * 与 taskListVersion，tab 标签/顺序等与目录无关的变化也会整树重读。
 */
it("tabs 引用变化但 workspace 集合不变、taskListVersion 变化时都不重读目录；集合变化才重读", async () => {
  mocks.services = {
    projectService: {},
    remoteProjectService: {},
    broadcastService: { onMessage: () => ({ dispose: vi.fn() }) },
    zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose: vi.fn() }) },
  };
  mocks.read.mockResolvedValue({
    tree: { projects: [], tasks: [] },
    directory: { hosts: [], entries: [] },
    availability: new Map(),
  });
  mocks.tabs = [workspaceTab("/a", "A"), workspaceTab("/b", "B")];
  const { result, rerender } = renderHook(() => useProjectTree());
  await waitFor(() => expect(result.current.loading).toBe(false));
  const reads = mocks.read.mock.calls.length;

  mocks.tabs = [
    workspaceTab("/b", "B renamed"),
    workspaceTab("/a", "A renamed"),
    { id: "__settings__", kind: "settings", label: "settings" },
  ];
  rerender();
  mocks.sessionState = {
    ...mocks.sessionState,
    workspaces: { "/a": { taskListVersion: 3 }, "/b": { taskListVersion: 7 } },
  };
  rerender();
  await act(async () => {});
  expect(mocks.read.mock.calls.length).toBe(reads);

  mocks.tabs = [...mocks.tabs, workspaceTab("/c", "C")];
  rerender();
  await waitFor(() => expect(mocks.read.mock.calls.length).toBe(reads + 1));
});
