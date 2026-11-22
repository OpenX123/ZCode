// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_NOTIFICATION_PREFERENCES, type AppSettings } from "@zcode/shared";

const settingsState = vi.hoisted(() => ({
  settings: null as Partial<AppSettings> | null,
  update: vi.fn(async (_patch: Partial<AppSettings>) => {}),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: settingsState.settings, update: settingsState.update }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({}),
}));

async function load() {
  const hooks = await import("@/hooks/task-notifications/index.js");
  const projection = await import("@/lib/taskNotificationPreferences.js");
  return { hooks, projection };
}

describe("任务通知偏好 bridge 与写入", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    settingsState.settings = null;
    settingsState.update.mockReset();
    settingsState.update.mockResolvedValue(undefined);
  });

  it("设置缺席且有旧 key：迁移写入设置，成功后删除旧 key", async () => {
    localStorage.setItem("zcode-notification-sound-enabled", "false");
    const { hooks, projection } = await load();
    settingsState.settings = { locale: "zh-CN" } as Partial<AppSettings>;
    renderHook(() => hooks.useTaskNotificationPreferencesBridge());
    const migrated = {
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      completedSound: "mute",
      attentionSound: "mute",
    };
    await waitFor(() =>
      expect(settingsState.update).toHaveBeenCalledWith({ taskNotificationPreferences: migrated }),
    );
    await waitFor(() =>
      expect(localStorage.getItem("zcode-notification-sound-enabled")).toBeNull(),
    );
    expect(projection.getTaskNotificationPreferences()).toEqual(migrated);
  });

  it("迁移写入失败保留旧 key", async () => {
    localStorage.setItem("zcode-notification-enabled", "false");
    settingsState.update.mockRejectedValue(new Error("disk full"));
    const { hooks } = await load();
    settingsState.settings = {} as Partial<AppSettings>;
    renderHook(() => hooks.useTaskNotificationPreferencesBridge());
    await waitFor(() => expect(settingsState.update).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(localStorage.getItem("zcode-notification-enabled")).toBe("false");
  });

  it("设置已有偏好时以设置为准，不迁移", async () => {
    localStorage.setItem("zcode-notification-enabled", "false");
    const { hooks, projection } = await load();
    const stored = { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES, attentionSound: "chime" as const };
    settingsState.settings = { taskNotificationPreferences: stored } as Partial<AppSettings>;
    renderHook(() => hooks.useTaskNotificationPreferencesBridge());
    await waitFor(() => expect(projection.getTaskNotificationPreferences()).toEqual(stored));
    expect(settingsState.update).not.toHaveBeenCalled();
  });

  it("update 乐观更新投影并写入完整偏好；失败回滚", async () => {
    const { hooks, projection } = await load();
    const { result } = renderHook(() => hooks.useTaskNotificationPreferences());
    await act(async () => {
      await result.current.update({ playWhenFocused: true });
    });
    expect(settingsState.update).toHaveBeenCalledWith({
      taskNotificationPreferences: {
        ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
        playWhenFocused: true,
      },
    });
    expect(result.current.preferences.playWhenFocused).toBe(true);

    settingsState.update.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.update({ enabled: false })).rejects.toThrow("offline");
    });
    expect(projection.getTaskNotificationPreferences().enabled).toBe(true);
  });
});
