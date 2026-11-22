# 任务通知偏好 UI

本机 `AppSettings.taskNotificationPreferences` 是唯一持久化 owner（多窗口共享 Host 设置文件）。Renderer 只有一份投影：`lib/taskNotificationPreferences.ts` 的模块快照；提示音播放器与组件只读快照。规则与时序见 `docs/desktop/task-notification-sounds.md`。

- `TaskNotificationPreferencesBridge` 在 App 根部挂载一次，按 `planTaskNotificationPreferencesSync` 把设置写入快照，并在设置缺席时把旧 localStorage key 迁移进设置（成功后删除旧 key）。
- `useTaskNotificationPreferences()`（hooks/task-notifications）读取快照，`update(patch)` 乐观更新快照后经本机 `settingService` 写入；失败回滚并 toast。跨窗口刷新复用 Main 的 `SettingsChanged`。
- `TaskNotificationSettings` 是纯展示组件：总开关、两类提示音选择与试听、前台播放开关；试听经 `previewTaskNotificationSound`。
- 不经 `window.zcode`，不写远端工作区设置，不再使用 Zustand 广播 `state:notificationEnabled`。
