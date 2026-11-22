/** 任务通知偏好与提示音设置：AppSettings 为唯一持久化 owner，UI 只投影与发命令。 */
export const taskNotificationsUiModule = {
  id: "task-notifications-ui",
  requires: ["ui", "shared"],
  provides: ["task-notifications-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "../hooks/task-notifications/index.ts"],
} as const;
