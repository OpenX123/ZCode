import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_NOTIFICATION_PREFERENCES } from "@zcode/shared";
import {
  TASK_NOTIFICATION_SOUND_OPTIONS,
  mergeTaskNotificationPreferences,
  planTaskNotificationPreferencesSync,
} from "./contract.js";

const defaults = DEFAULT_TASK_NOTIFICATION_PREFERENCES;
const muted = { ...defaults, completedSound: "mute" as const, attentionSound: "mute" as const };

describe("任务通知偏好同步契约", () => {
  it("设置未加载时保持首帧快照，不迁移", () => {
    expect(
      planTaskNotificationPreferencesSync({
        settingsLoaded: false,
        stored: undefined,
        legacy: muted,
        defaults,
      }),
    ).toEqual({ snapshot: null, migrate: null });
  });

  it("设置已有偏好时以设置为准，忽略旧 key", () => {
    const stored = { ...defaults, attentionSound: "chime" as const };
    expect(
      planTaskNotificationPreferencesSync({
        settingsLoaded: true,
        stored,
        legacy: muted,
        defaults,
      }),
    ).toEqual({ snapshot: stored, migrate: null });
  });

  it("设置缺席且存在旧 key 时投影旧值并迁移", () => {
    expect(
      planTaskNotificationPreferencesSync({
        settingsLoaded: true,
        stored: undefined,
        legacy: muted,
        defaults,
      }),
    ).toEqual({ snapshot: muted, migrate: muted });
  });

  it("没有任何来源时投影默认值，不写设置", () => {
    expect(
      planTaskNotificationPreferencesSync({
        settingsLoaded: true,
        stored: undefined,
        legacy: null,
        defaults,
      }),
    ).toEqual({ snapshot: defaults, migrate: null });
  });

  it("补丁合并只改动指定字段", () => {
    expect(mergeTaskNotificationPreferences(defaults, { playWhenFocused: true })).toEqual({
      ...defaults,
      playWhenFocused: true,
    });
  });

  it("下拉包含默认 pop、5 种合成音色与静音", () => {
    expect(TASK_NOTIFICATION_SOUND_OPTIONS).toEqual([
      "pop",
      "crisp",
      "soft",
      "woodblock",
      "droplet",
      "chime",
      "mute",
    ]);
  });
});
