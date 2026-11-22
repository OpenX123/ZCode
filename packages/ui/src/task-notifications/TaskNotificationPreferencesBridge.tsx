import { useTaskNotificationPreferencesBridge } from "@/hooks/task-notifications/index.js";

/** App 根部挂载一次：把本机设置同步到 renderer 投影，并迁移旧 localStorage 偏好。 */
export function TaskNotificationPreferencesBridge() {
  useTaskNotificationPreferencesBridge();
  return null;
}
