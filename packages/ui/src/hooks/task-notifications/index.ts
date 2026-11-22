import { useCallback, useEffect, useRef } from "react";
import { DEFAULT_TASK_NOTIFICATION_PREFERENCES } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  clearLegacyTaskNotificationPreferences,
  getTaskNotificationPreferences,
  normalizeTaskNotificationPreferences,
  readLegacyTaskNotificationPreferences,
  setTaskNotificationPreferencesSnapshot,
  useTaskNotificationPreferencesSnapshot,
} from "@/lib/taskNotificationPreferences.js";
import {
  mergeTaskNotificationPreferences,
  planTaskNotificationPreferencesSync,
  type TaskNotificationPreferencesPatch,
} from "@/task-notifications/contract.js";

/**
 * 读取并修改任务通知偏好。写入本机设置（base services），远程工作区不写远端设置。
 * 乐观更新投影；写入失败回滚并把错误抛给调用方提示。
 */
export function useTaskNotificationPreferences() {
  const preferences = useTaskNotificationPreferencesSnapshot();
  const localServices = useBaseWorkspaceServices();
  const { update: updateSettings } = useSettings({ services: localServices });
  const update = useCallback(
    async (patch: TaskNotificationPreferencesPatch) => {
      const previous = getTaskNotificationPreferences();
      const next = mergeTaskNotificationPreferences(previous, patch);
      setTaskNotificationPreferencesSnapshot(next);
      try {
        await updateSettings({ taskNotificationPreferences: next });
      } catch (error) {
        setTaskNotificationPreferencesSnapshot(previous);
        throw error;
      }
    },
    [updateSettings],
  );
  return { preferences, update };
}

/**
 * 设置 → 投影的唯一同步路径；App 根部挂载一次。
 * 设置缺席时把旧 localStorage key 迁移进设置，成功后删除旧 key。
 */
export function useTaskNotificationPreferencesBridge(): void {
  const localServices = useBaseWorkspaceServices();
  const { settings, update } = useSettings({ services: localServices });
  const migratingRef = useRef(false);
  const stored = settings?.taskNotificationPreferences;
  const settingsLoaded = settings !== null;

  useEffect(() => {
    const plan = planTaskNotificationPreferencesSync({
      settingsLoaded,
      stored: stored ? normalizeTaskNotificationPreferences(stored) : undefined,
      legacy: readLegacyTaskNotificationPreferences(),
      defaults: DEFAULT_TASK_NOTIFICATION_PREFERENCES,
    });
    if (plan.snapshot) setTaskNotificationPreferencesSnapshot(plan.snapshot);
    if (!plan.migrate || migratingRef.current) return;
    migratingRef.current = true;
    const migrated = plan.migrate;
    void update({ taskNotificationPreferences: migrated })
      .then(() => {
        clearLegacyTaskNotificationPreferences();
        logger.info("[task-notification] migrated legacy preferences to app settings");
      })
      .catch((error: unknown) => {
        // 写入失败保留旧 key，下次启动重试；本次会话继续使用旧值投影。
        logger.warn("[task-notification] failed to migrate legacy preferences", error);
      })
      .finally(() => {
        migratingRef.current = false;
      });
  }, [settingsLoaded, stored, update]);
}
