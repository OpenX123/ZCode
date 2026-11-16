// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useWorkbenchSessionTitle } from "@/project-sidebar/useWorkbenchSessionTitle.js";
import type { WorkbenchTab } from "@/v4/workbench-tabs/index.js";

const fixture = vi.hoisted(() => ({
  tasks: [] as ZCodeTaskMeta[],
  workspaces: {} as Record<string, { taskListCache: ZCodeTaskMeta[] }>,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector(fixture),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => ({ factTree: { tasks: fixture.tasks } }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "新会话" } }),
}));
const tab = {
  id: "view",
  sessionId: "session",
  workspaceScope: { workspacePath: "/same" },
} as WorkbenchTab;
const meta = (title: string, updatedAt = 1, titleOverridden = false): ZCodeTaskMeta => ({
  taskId: "session",
  workspacePath: "/same",
  title,
  updatedAt,
  titleOverridden,
  createdAt: 1,
  mode: "build",
  traceId: "trace",
  provider: "glm",
});
beforeEach(() => {
  fixture.tasks = [];
  fixture.workspaces = {};
});

describe("工作台共享只读标题", () => {
  it.each([
    ["缺缓存使用事实", undefined, meta("目录事实"), "目录事实"],
    ["陈旧非空缓存不盖新事实", meta("旧首输入"), meta("生成标题", 2), "生成标题"],
    ["新缓存不被旧目录降级", meta("新标题", 3), meta("旧标题", 2), "新标题"],
    ["手动标题保护", meta("手动标题", 1, true), meta("自动标题", 2), "手动标题"],
    ["新手动标题替换旧手动标题", meta("旧手动", 1, true), meta("新手动", 2, true), "新手动"],
    ["陈旧占位缓存", meta("New session"), meta("首条输入", 2), "首条输入"],
    ["冷恢复占位不盖有效标题", meta("生成标题", 2), meta("New session", 3), "生成标题"],
    ["首输入可直接展示", undefined, meta("首条输入"), "首条输入"],
    ["真实空标题", undefined, meta("   "), "新会话"],
    ["默认占位本地化", undefined, meta("New session"), "新会话"],
    ["真正缺失", undefined, undefined, "新会话"],
  ])("%s", (_name, cached, fact, expected) => {
    fixture.workspaces = cached ? { "/same": { taskListCache: [cached] } } : {};
    fixture.tasks = fact ? [fact] : [];
    expect(renderHook(() => useWorkbenchSessionTitle(tab)).result.current).toBe(expected);
  });

  it("草稿不读取同 scope 的历史标题", () => {
    fixture.tasks = [meta("历史标题")];
    expect(
      renderHook(() => useWorkbenchSessionTitle({ ...tab, sessionId: null })).result.current,
    ).toBe("新会话");
  });

  it("同 path/ID 的两个远端按完整 identity 读取，不借用 path 缓存", () => {
    const first = "remote:server:a:/same";
    const second = "remote:server:b:/same";
    fixture.workspaces = { "/same": { taskListCache: [meta("不能串入的本地标题", 99)] } };
    fixture.tasks = [
      { ...meta("远端 A"), workspaceIdentity: first },
      { ...meta("远端 B"), workspaceIdentity: second },
    ];
    for (const [identity, expected] of [
      [first, "远端 A"],
      [second, "远端 B"],
    ]) {
      expect(
        renderHook(() =>
          useWorkbenchSessionTitle({
            ...tab,
            workspaceScope: {
              workspacePath: "/same",
              workspaceIdentity: ` ${identity} `,
              remoteSessionId: identity,
            },
          }),
        ).result.current,
      ).toBe(expected);
    }
  });

  it("事实更新与缓存清空后仍同步且不降级", () => {
    fixture.workspaces = { "/same": { taskListCache: [meta("首输入")] } };
    fixture.tasks = [meta("首输入")];
    const view = renderHook(() => useWorkbenchSessionTitle(tab));
    fixture.tasks = [meta("生成标题", 2)];
    view.rerender();
    expect(view.result.current).toBe("生成标题");
    fixture.workspaces = {};
    view.rerender();
    expect(view.result.current).toBe("生成标题");
    fixture.tasks = [meta("手动标题", 3, true)];
    view.rerender();
    expect(view.result.current).toBe("手动标题");
  });
});
