import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_NOTIFICATION_PREFERENCES } from "@zcode/shared";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

interface AudioStub {
  src: string;
  preload: string;
  currentTime: number;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
}

function installAudioMock() {
  const instances: AudioStub[] = [];
  const audioConstructor = vi.fn(function AudioMock(src: string) {
    const audio: AudioStub = {
      src,
      preload: "",
      currentTime: 9,
      pause: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
    };
    instances.push(audio);
    return audio;
  });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: audioConstructor });
  return { audioConstructor, instances };
}

describe("任务通知偏好投影与旧 key 迁移", () => {
  beforeEach(() => {
    localStorageState.clear();
    vi.resetModules();
  });

  it("没有旧 key 时首帧为默认值且无需迁移", async () => {
    const mod = await import("../src/lib/taskNotificationPreferences.js");
    expect(mod.readLegacyTaskNotificationPreferences()).toBeNull();
    expect(mod.getTaskNotificationPreferences()).toEqual(DEFAULT_TASK_NOTIFICATION_PREFERENCES);
  });

  it("旧版关闭通知/提示音映射为 enabled=false 与两类静音，首帧即生效", async () => {
    localStorageState.set("zcode-notification-enabled", "false");
    localStorageState.set("zcode-notification-sound-enabled", "false");
    const mod = await import("../src/lib/taskNotificationPreferences.js");
    const expected = {
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      enabled: false,
      completedSound: "mute",
      attentionSound: "mute",
    };
    expect(mod.readLegacyTaskNotificationPreferences()).toEqual(expected);
    expect(mod.getTaskNotificationPreferences()).toEqual(expected);
  });

  it("迁移成功后删除旧 key", async () => {
    localStorageState.set("zcode-notification-enabled", "true");
    localStorageState.set("zcode-notification-sound-enabled", "true");
    const mod = await import("../src/lib/taskNotificationPreferences.js");
    expect(mod.readLegacyTaskNotificationPreferences()).toEqual(
      DEFAULT_TASK_NOTIFICATION_PREFERENCES,
    );
    mod.clearLegacyTaskNotificationPreferences();
    expect(localStorageState.size).toBe(0);
  });

  it("设置值逐字段校验，非法字段回落默认值", async () => {
    const mod = await import("../src/lib/taskNotificationPreferences.js");
    expect(
      mod.normalizeTaskNotificationPreferences({
        enabled: false,
        completedSound: "unknown" as never,
        attentionSound: "chime",
      }),
    ).toEqual({
      enabled: false,
      completedSound: "pop",
      attentionSound: "chime",
      playWhenFocused: false,
    });
  });

  it("快照变更通知订阅者，相同值不重复通知", async () => {
    const mod = await import("../src/lib/taskNotificationPreferences.js");
    const listener = vi.fn();
    mod.subscribeTaskNotificationPreferences(listener);
    const next = { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES, playWhenFocused: true };
    mod.setTaskNotificationPreferencesSnapshot(next);
    mod.setTaskNotificationPreferencesSnapshot({ ...next });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("提示音播放器判定", () => {
  beforeEach(() => {
    localStorageState.clear();
    vi.resetModules();
  });

  async function load(preferences: Partial<typeof DEFAULT_TASK_NOTIFICATION_PREFERENCES>) {
    const prefs = await import("../src/lib/taskNotificationPreferences.js");
    prefs.setTaskNotificationPreferencesSnapshot({
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      ...preferences,
    });
    return import("../src/lib/taskNotificationSound.js");
  }

  it("后台时按类别播放所选音色", async () => {
    const { audioConstructor, instances } = installAudioMock();
    const sound = await load({ completedSound: "crisp", attentionSound: "chime" });
    await sound.playTaskNotificationSound({ category: "attention", appFocused: false });
    expect(audioConstructor).toHaveBeenCalledTimes(1);
    expect(String(instances[0]!.src)).toContain("chime");
    expect(instances[0]!.currentTime).toBe(0);
    expect(instances[0]!.play).toHaveBeenCalledTimes(1);
  });

  it("前台默认不响；开启“前台也播放”后响", async () => {
    const { audioConstructor } = installAudioMock();
    let sound = await load({});
    await sound.playTaskNotificationSound({ category: "completed", appFocused: true });
    expect(audioConstructor).not.toHaveBeenCalled();
    vi.resetModules();
    sound = await load({ playWhenFocused: true });
    await sound.playTaskNotificationSound({ category: "completed", appFocused: true });
    expect(audioConstructor).toHaveBeenCalledTimes(1);
  });

  it("总开关关闭或类别静音时不播放", async () => {
    const { audioConstructor } = installAudioMock();
    let sound = await load({ enabled: false });
    await sound.playTaskNotificationSound({ category: "completed", appFocused: false });
    vi.resetModules();
    sound = await load({ attentionSound: "mute" });
    await sound.playTaskNotificationSound({ category: "attention", appFocused: false });
    expect(audioConstructor).not.toHaveBeenCalled();
  });

  it("试听不受总开关与前台规则限制，静音不播放", async () => {
    const { audioConstructor } = installAudioMock();
    const sound = await load({ enabled: false });
    await sound.previewTaskNotificationSound("woodblock");
    await sound.previewTaskNotificationSound("mute");
    expect(audioConstructor).toHaveBeenCalledTimes(1);
  });

  it("通知状态映射到两类提示音，提示音意图做运行时校验", async () => {
    const { taskNotificationSoundCategory, parseTaskNotificationSoundCue } =
      await import("@zcode/shared");
    expect(taskNotificationSoundCategory("completed")).toBe("completed");
    expect(taskNotificationSoundCategory("feedback_update")).toBe("completed");
    expect(taskNotificationSoundCategory("failed")).toBe("attention");
    expect(taskNotificationSoundCategory("permission_request")).toBe("attention");
    expect(taskNotificationSoundCategory("elicitation_request")).toBe("attention");
    expect(parseTaskNotificationSoundCue({ category: "attention", appFocused: true })).toEqual({
      category: "attention",
      appFocused: true,
    });
    expect(parseTaskNotificationSoundCue({ category: "other", appFocused: true })).toBeNull();
    expect(parseTaskNotificationSoundCue(undefined)).toBeNull();
  });
});
