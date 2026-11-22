// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillsHubState } from "@zcode/shared/skills-hub";
import { SkillsHubPanel } from "@/settings/skills-hub/index.js";
import { useSkillsHub } from "@/hooks/skills-hub/index.js";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirm }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function hubState(overrides: Partial<SkillsHubState> = {}): SkillsHubState {
  return {
    available: true,
    syncedAt: 1,
    managedLinkCount: 3,
    createdCount: 0,
    removedCount: 0,
    conflicts: [],
    pruneCandidates: [],
    newSkills: [],
    issues: [],
    ...overrides,
  };
}

function renderPanel(
  state: SkillsHubState | null,
  handlers: Partial<Record<string, unknown>> = {},
) {
  const props = {
    state,
    busy: false,
    error: null,
    onSync: vi.fn(),
    onPrune: vi.fn(),
    onChoose: vi.fn(),
    onDismissNew: vi.fn(),
    ...handlers,
  };
  render(createElement(SkillsHubPanel, props));
  return props;
}

describe("SkillsHubPanel", () => {
  it("说明开关只作用于 YCode 原生引擎，并可立即同步", () => {
    const props = renderPanel(hubState());
    expect(screen.getByText("settings.skills.hub.engineNote")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.skills.hub.syncNow"));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("不可用时不渲染", () => {
    const { container } = render(
      createElement(SkillsHubPanel, {
        state: hubState({ available: false }),
        busy: false,
        error: null,
        onSync: vi.fn(),
        onPrune: vi.fn(),
        onChoose: vi.fn(),
        onDismissNew: vi.fn(),
      }),
    );
    expect(container.innerHTML).toBe("");
  });

  it("清理按钮显示数量，确认后只提交候选条目名", async () => {
    confirm.mockResolvedValue(true);
    const props = renderPanel(
      hubState({
        pruneCandidates: [
          {
            entryName: "legacy-bar",
            target: "/h/.agents/skills/bar",
            reason: "agents",
            managed: false,
          },
        ],
      }),
    );
    fireEvent.click(screen.getByText('settings.skills.hub.prune:{"count":1}'));
    await waitFor(() => expect(props.onPrune).toHaveBeenCalledWith(["legacy-bar"]));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmVariant: "destructive", intent: "skills-hub-prune" }),
    );
  });

  it("取消确认时不清理", async () => {
    confirm.mockResolvedValue(false);
    const props = renderPanel(
      hubState({
        pruneCandidates: [
          {
            entryName: "dup",
            target: "/h/.claude/skills/dup",
            reason: "duplicate",
            managed: false,
          },
        ],
      }),
    );
    fireEvent.click(screen.getByText('settings.skills.hub.prune:{"count":1}'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(props.onPrune).not.toHaveBeenCalled();
  });

  it("冲突区块按来源列出各份并可改选与恢复默认", () => {
    const props = renderPanel(
      hubState({
        conflicts: [
          {
            nameKey: "foo",
            name: "foo",
            chosenRealDir: "/h/.codex/skills/foo",
            defaultRealDir: "/h/.claude/skills/foo",
            userChosen: true,
            variants: [
              { realDir: "/h/.claude/skills/foo", source: { kind: "claude" }, memberSources: [] },
              { realDir: "/h/.codex/skills/foo", source: { kind: "codex" }, memberSources: [] },
            ],
          },
        ],
      }),
    );
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.skills.hub.conflicts.use"));
    expect(props.onChoose).toHaveBeenCalledWith("foo", "/h/.claude/skills/foo");
    fireEvent.click(screen.getByText("settings.skills.hub.conflicts.reset"));
    expect(props.onChoose).toHaveBeenCalledWith("foo", null);
  });

  it("新发现提示列出技能并可确认", () => {
    const props = renderPanel(
      hubState({
        newSkills: [
          { nameKey: "b", name: "b", source: { kind: "claudePlugin", pluginName: "superp" } },
        ],
      }),
    );
    expect(screen.getByText('settings.skills.hub.newSkills:{"count":1}')).toBeTruthy();
    expect(screen.getByText("superp")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.skills.hub.newSkills.dismiss"));
    expect(props.onDismissNew).toHaveBeenCalledTimes(1);
  });
});

describe("useSkillsHub", () => {
  function createService(initial: SkillsHubState) {
    const listeners = new Set<(state: SkillsHubState) => void>();
    return {
      service: {
        syncHub: vi.fn(async () => initial),
        pruneHubLinks: vi.fn(async () => hubState({ managedLinkCount: 1 })),
        setHubConflictChoice: vi.fn(async () => hubState({ managedLinkCount: 2 })),
        dismissHubDiscoveries: vi.fn(async () => hubState()),
        onDidChangeHub: (listener: (state: SkillsHubState) => void) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      },
      emit: (state: SkillsHubState) => listeners.forEach((listener) => listener(state)),
    };
  }

  it("打开时同步一次；无变化的同步不触发刷新，改选触发刷新", async () => {
    const { service } = createService(hubState());
    const onChanged = vi.fn();
    const { result } = renderHook(() =>
      useSkillsHub({ skillsService: service, enabled: true, onChanged }),
    );
    await waitFor(() => expect(result.current.state?.managedLinkCount).toBe(3));
    expect(service.syncHub).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith("sync", false);

    result.current.choose("foo", "/h/.codex/skills/foo");
    await waitFor(() => expect(result.current.state?.managedLinkCount).toBe(2));
    expect(service.setHubConflictChoice).toHaveBeenCalledWith({
      nameKey: "foo",
      realDir: "/h/.codex/skills/foo",
    });
    expect(onChanged).toHaveBeenLastCalledWith("choose", true);
  });

  it("关闭时不调用服务；事件整体替换状态", async () => {
    const { service, emit } = createService(hubState());
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSkillsHub({ skillsService: service, enabled }),
      { initialProps: { enabled: false } },
    );
    expect(service.syncHub).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state).not.toBeNull());
    emit(hubState({ managedLinkCount: 9 }));
    await waitFor(() => expect(result.current.state?.managedLinkCount).toBe(9));
  });
});
