import { DEFAULT_TASK_NOTIFICATION_PREFERENCES } from "@zcode/shared";
import { planTaskNotificationPreferencesSync } from "./contract.js";

/** 旧版关闭提示音的用户首次启动：投影静音并迁移写入设置。 */
export function exampleTaskNotificationMigration() {
  return planTaskNotificationPreferencesSync({
    settingsLoaded: true,
    stored: undefined,
    legacy: {
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      completedSound: "mute",
      attentionSound: "mute",
    },
    defaults: DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  });
}
