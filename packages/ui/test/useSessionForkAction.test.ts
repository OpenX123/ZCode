// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionForkAction } from "@/hooks/useZCodeTaskService.js";

const mock = vi.hoisted(() => ({ service: { forkTask: vi.fn() } }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({ zcodeTaskService: mock.service }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeTaskService: mock.service }),
}));
afterEach(cleanup);

describe("会话分叉请求", () => {
  it("多次触发和多个菜单挂载共用 pending 请求与操作 ID", async () => {
    let finish!: (value: unknown) => void;
    mock.service.forkTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const scope = {
      workspacePath: "/project",
      workspaceIdentity: "ssh:source",
      remoteSessionId: "endpoint",
    };
    const first = renderHook(() => useSessionForkAction(scope, "source-a"));
    const second = renderHook(() => useSessionForkAction(scope, "source-a"));
    let a!: ReturnType<typeof first.result.current.fork>;
    let b!: ReturnType<typeof first.result.current.fork>;
    await act(async () => {
      a = first.result.current.fork("worktree");
      b = second.result.current.fork("worktree");
      await Promise.resolve();
    });
    expect(a).toBe(b);
    expect(first.result.current.pending).toBe(true);
    expect(second.result.current.pending).toBe(true);
    expect(mock.service.forkTask).toHaveBeenCalledTimes(1);
    expect(mock.service.forkTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "source-a",
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        operationId: expect.any(String),
        mode: "worktree",
      }),
    );
    await act(async () => {
      finish({ taskId: "child", workspacePath: "/child", forkKind: "history" });
      await a;
    });
    expect(first.result.current.pending).toBe(false);
  });
  it("失败重试复用操作 ID，成功后新的用户操作使用新 ID", async () => {
    mock.service.forkTask
      .mockReset()
      .mockRejectedValueOnce(new Error("transport disconnected"))
      .mockResolvedValue({ taskId: "child-b", workspacePath: "/project", forkKind: "native" });
    const hook = renderHook(() => useSessionForkAction({ workspacePath: "/project" }, "source-b"));
    await act(async () => {
      await expect(hook.result.current.fork("same-directory")).rejects.toThrow(
        "transport disconnected",
      );
    });
    await act(async () => {
      await hook.result.current.fork("same-directory");
    });
    const firstId = mock.service.forkTask.mock.calls[0]![0].operationId;
    expect(mock.service.forkTask.mock.calls[1]![0].operationId).toBe(firstId);
    await act(async () => {
      await hook.result.current.fork("same-directory");
    });
    expect(mock.service.forkTask).toHaveBeenCalledTimes(2);
    act(() => hook.result.current.complete());
    await act(async () => {
      await hook.result.current.fork("same-directory");
    });
    expect(mock.service.forkTask.mock.calls[2]![0].operationId).not.toBe(firstId);
  });
});
