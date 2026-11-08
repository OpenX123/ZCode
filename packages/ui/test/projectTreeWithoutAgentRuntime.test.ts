// @vitest-environment jsdom
// docs/desktop/engine-performance-1.1-spec.md「只为可见工作区启动 CLI」VW03：
// 不可见工作区不再随窗口打开拉起 CLI，侧栏任务列表必须仍完整显示。侧栏项目树的事实来自 Host
// （project.readTree 读项目库与 tasks-index），这里把 Agent / Session 服务换成记录调用的代理，
// 证明 3 个工作区的任务在没有任何 CLI 请求的情况下全部显示。
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [] as unknown[],
  sessionState: {
    workspaces: {} as Record<string, { taskListVersion: number }>,
    removeTaskState: () => {},
  },
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
vi.mock("@/project-sidebar/useProjectUnreadSignals.js", () => ({
  useProjectUnreadSignals: () => {},
}));
// 侧栏的活性叠加走 sessions-index，其订阅为 existing-only（不拉起 CLI）；行本身不依赖它。
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 任何方法调用都会被记录：侧栏读取不得经由 Agent / Session 服务（它们会按工作区拉起 CLI）。 */
function recordingService(name: string, calls: string[]) {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        typeof property === "string" && property !== "then"
          ? (..._args: unknown[]) => {
              calls.push(`${name}.${property}`);
              return Promise.reject(new Error("agent runtime must not be started"));
            }
          : undefined,
    },
  );
}

const WORKSPACES = ["/w1", "/w2", "/w3"];

function project(index: number, rootPath: string) {
  return {
    id: `project-${index}`,
    hostId: "local",
    name: `P${index}`,
    nameOverridden: false,
    roots: [{ rootPath, position: 0, isPrimary: true }],
    position: index,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function task(index: number, workspacePath: string) {
  return {
    taskId: `task-${index}`,
    workspacePath,
    title: `任务 ${index}`,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    projectId: `project-${index}`,
    hostId: "local",
    pinned: false,
    archived: false,
  };
}

it("VW03：只有 1 个工作区可见、其余工作区没有 CLI 时，侧栏仍显示 3 个工作区的任务", async () => {
  const agentCalls: string[] = [];
  mocks.tabs = WORKSPACES.map((workspacePath) => ({
    id: `tab:${workspacePath}`,
    kind: "workspace",
    workspacePath,
    label: workspacePath,
  }));
  mocks.services = {
    projectService: {
      readTree: vi.fn(async () => ({
        projects: WORKSPACES.map((path, index) => project(index, path)),
        tasks: WORKSPACES.map((path, index) => task(index, path)),
      })),
    },
    remoteProjectService: {
      readDirectory: vi.fn(async () => ({ hosts: [], entries: [] })),
    },
    broadcastService: { onMessage: () => ({ dispose: vi.fn() }) },
    zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose: vi.fn() }) },
    zcodeAgentService: recordingService("zcodeAgentService", agentCalls),
    zcodeSessionService: recordingService("zcodeSessionService", agentCalls),
  };

  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(result.current.loading).toBe(false));

  expect(result.current.error).toBeNull();
  expect(new Set(result.current.tree.tasks.map((item) => item.workspacePath))).toEqual(
    new Set(WORKSPACES),
  );
  expect(result.current.tree.projects).toHaveLength(3);
  expect(agentCalls).toEqual([]);
});
