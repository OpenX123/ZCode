import { useSyncExternalStore } from "react";
import {
  DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  TASK_NOTIFICATION_SOUND_IDS,
  type TaskNotificationPreferences,
  type TaskNotificationSoundId,
} from "@zcode/shared";

/**
 * 任务通知偏好的 renderer 唯一投影（spec：docs/desktop/task-notification-sounds.md）。
 *
 * 持久化 owner 是本机 AppSettings.taskNotificationPreferences（Host 设置文件，多窗口共享）；
 * 本模块只缓存最近一次从设置读到的值，供组件与提示音播放器同步读取。快照只由
 * TaskNotificationPreferencesBridge 写入，组件不得自行持有第二份偏好状态。
 */

/** 1.5.0 前的 localStorage key；仅用于一次性迁移与设置加载前的首帧推导。 */
const LEGACY_TASK_NOTIFICATION_ENABLED_STORAGE_KEY = "zcode-notification-enabled";
const LEGACY_TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = "zcode-notification-sound-enabled";

function readLegacyValue(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 旧 key 推导的偏好；没有任何旧 key 时返回 null（无需迁移）。 */
export function readLegacyTaskNotificationPreferences(): TaskNotificationPreferences | null {
  const enabled = readLegacyValue(LEGACY_TASK_NOTIFICATION_ENABLED_STORAGE_KEY);
  const soundEnabled = readLegacyValue(LEGACY_TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY);
  if (enabled === null && soundEnabled === null) return null;
  // 旧版只有“提示音开/关”；关闭等价于两类都选静音。
  const sound: TaskNotificationSoundId | undefined = soundEnabled === "false" ? "mute" : undefined;
  return {
    ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
    enabled: enabled !== "false",
    completedSound: sound ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES.completedSound,
    attentionSound: sound ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES.attentionSound,
  };
}

/** 迁移写入设置成功后删除旧 key；失败保留，下次启动重试。 */
export function clearLegacyTaskNotificationPreferences(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_TASK_NOTIFICATION_ENABLED_STORAGE_KEY);
    globalThis.localStorage?.removeItem(LEGACY_TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY);
  } catch {
    // localStorage 不可用时没有旧 key 可清理。
  }
}

function isSoundId(value: unknown): value is TaskNotificationSoundId {
  return (TASK_NOTIFICATION_SOUND_IDS as readonly unknown[]).includes(value);
}

/** 设置值可能来自旧版本或手改文件；逐字段校验，非法字段回落默认值。 */
export function normalizeTaskNotificationPreferences(
  value: Partial<TaskNotificationPreferences> | null | undefined,
): TaskNotificationPreferences {
  const defaults = DEFAULT_TASK_NOTIFICATION_PREFERENCES;
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    completedSound: isSoundId(value?.completedSound)
      ? value.completedSound
      : defaults.completedSound,
    attentionSound: isSoundId(value?.attentionSound)
      ? value.attentionSound
      : defaults.attentionSound,
    playWhenFocused:
      typeof value?.playWhenFocused === "boolean"
        ? value.playWhenFocused
        : defaults.playWhenFocused,
  };
}

function arePreferencesEqual(
  left: TaskNotificationPreferences,
  right: TaskNotificationPreferences,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.completedSound === right.completedSound &&
    left.attentionSound === right.attentionSound &&
    left.playWhenFocused === right.playWhenFocused
  );
}

// 首帧（设置尚未加载）沿用旧 key 推导值，避免已关闭通知的用户启动瞬间闪回默认开启。
let snapshot: TaskNotificationPreferences =
  readLegacyTaskNotificationPreferences() ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES;
const listeners = new Set<() => void>();

export function getTaskNotificationPreferences(): TaskNotificationPreferences {
  return snapshot;
}

export function subscribeTaskNotificationPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 只读投影 hook；组件、角标门控与播放器读取同一份快照。 */
export function useTaskNotificationPreferencesSnapshot(): TaskNotificationPreferences {
  return useSyncExternalStore(
    subscribeTaskNotificationPreferences,
    getTaskNotificationPreferences,
    getTaskNotificationPreferences,
  );
}

/** 仅供 bridge（设置 → 快照）与本窗口乐观更新/回滚调用。 */
export function setTaskNotificationPreferencesSnapshot(next: TaskNotificationPreferences): void {
  const normalized = normalizeTaskNotificationPreferences(next);
  if (arePreferencesEqual(snapshot, normalized)) return;
  snapshot = normalized;
  for (const listener of listeners) listener();
}
