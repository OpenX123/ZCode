import type { TaskNotificationPreferences, TaskNotificationSoundId } from "@zcode/shared";

/**
 * 任务通知偏好 UI 契约（spec：docs/desktop/task-notification-sounds.md）。
 * 持久化 owner 为本机 AppSettings.taskNotificationPreferences；renderer 只有一份投影
 * （lib/taskNotificationPreferences.ts），本模块只做纯决策，不持有状态。
 */

/** 设置页下拉顺序：默认音色在前，静音在末尾。 */
export const TASK_NOTIFICATION_SOUND_OPTIONS: readonly TaskNotificationSoundId[] = [
  "pop",
  "crisp",
  "soft",
  "woodblock",
  "droplet",
  "chime",
  "mute",
];

export type TaskNotificationPreferencesPatch = Partial<TaskNotificationPreferences>;

export function mergeTaskNotificationPreferences(
  current: TaskNotificationPreferences,
  patch: TaskNotificationPreferencesPatch,
): TaskNotificationPreferences {
  return { ...current, ...patch };
}

export interface TaskNotificationPreferencesSyncPlan {
  /** 写入 renderer 投影的值；null 表示保持当前快照（如设置尚未加载）。 */
  snapshot: TaskNotificationPreferences | null;
  /** 需要写入设置的迁移值；null 表示无需迁移。 */
  migrate: TaskNotificationPreferences | null;
}

/**
 * 设置快照 → 投影的同步决策：
 * - 设置未加载：保持快照（首帧已由旧 key 推导）。
 * - 设置已有偏好：以设置为准，忽略旧 key。
 * - 设置缺席且有旧 key：投影旧值并迁移写入设置。
 * - 都没有：投影默认值，不写设置。
 */
export function planTaskNotificationPreferencesSync(params: {
  settingsLoaded: boolean;
  stored: TaskNotificationPreferences | undefined;
  legacy: TaskNotificationPreferences | null;
  defaults: TaskNotificationPreferences;
}): TaskNotificationPreferencesSyncPlan {
  if (!params.settingsLoaded) return { snapshot: null, migrate: null };
  if (params.stored) return { snapshot: params.stored, migrate: null };
  if (params.legacy) return { snapshot: params.legacy, migrate: params.legacy };
  return { snapshot: params.defaults, migrate: null };
}
