# Windows 任务栏未读角标（taskbar overlay badge）

## 背景

任务完成时桌面端有声音提醒，但用户在听歌或专注别的事情时容易错过。需要在任务栏的应用图标上显示数字角标（类似 macOS Dock 角标），让"有几个已完成的会话没看"一眼可见。

应用级未读角标链路早已存在（renderer 统计 → IPC → 主进程聚合 → `app.setBadgeCount`），macOS / Linux 已生效；Windows 因 Electron `app.setBadgeCount` 在该平台是 no-op，一期刻意保持 no-op（见 `unreadBadge.ts` 原注释与用例）。本文是二期的 Windows 补齐 spec。

## 角标语义

- 角标数字 = **需要用户关注的任务数** = 未读已完成任务 ∪ 等待用户操作（审批/提问）的任务，按 host + workspace identity + taskId 去重，同一任务既未读又在等待时只计一次（1.5.0 起）。
- **未读已完成任务**：与侧栏蓝点**同一份权威数据**：host `projectService.readTree()` 返回的 ProjectTree（tasks-index SQLite 的 `unread_at`），且只统计**侧栏实际渲染的项目**：排除软删项目的任务与孤儿任务（projectId 无对应项目）——它们没有蓝点落点，计入只会产生「有角标没蓝点」的幽灵提醒。用户打开任务后由既有 compare-and-clear 清除 `unreadAt`。
- **等待用户操作的任务**：同一棵显示树（`ProjectDirectoryProvider` 的 `directory.tree`，已合并 sessions-index 活动）中带 `pendingInteraction` 或 `pendingInteractions` 摘要（permission/userInput 计数 > 0）的任务，可见性过滤与未读一致。每个等待态有一个签名：`pendingInteraction.interactionId`，缺失时为 `attention:<permissionCount>:<userInputCount>`。
- **打开即清除**：渲染进程在窗口获得焦点且文档可见时，把本窗口工作台各分栏**当前激活 tab** 绑定的任务视为“已查看”，对其当前等待签名记一次确认（acknowledgement），角标不再计入该等待态；任务出现新的等待请求（签名变化）会重新计入。等待态消失时确认记录随之清理。确认是窗口内存态（UI 局部，不写回 Host，不冒充服务端事实）；窗口重载后仍在等待的任务会重新计入，直到用户再次查看。窗口失焦时不记确认：激活 tab 上后台出现的审批仍会亮角标。
- 计数纯函数 `countProjectTreeBadgeTasks(tree, acknowledged)`（project-sidebar/view.ts），确认集合由 `ProjectDirectoryProvider` 的 owner 维护；旧 `countProjectTreeUnreadTasks` 保留为未读部分的实现。
- 归零后角标消失。不是历史完成总量。
- 历史教训：一期计数读 renderer session store 的 `workspace.taskListCache`，但该缓存只装载活跃 workspace 的列表——背景工作区蓝点亮着、角标却是 0。已废弃该路径（`lib/unreadTaskCount.ts` 删除），同步点在常驻的 `ProjectDirectoryProvider` owner。

## 全平台统一链路

```
[Host] projectService.readTree() → ProjectTree.tasks[].unreadAt（tasks-index SQLite 权威）
    │  ProjectDirectoryProvider owner（显示树 = 权威树 + sessions-index 活动）
    │  countProjectTreeBadgeTasks(tree, acknowledged)      project-sidebar/view.ts
    ▼
usePlatform().syncWindowUnreadCount(count)                 IPC: zcode:sync-window-unread-count
    │  （web 端为 no-op；树刷新时才触发，计数不变不发包）
    ▼
[Main] desktopMainIpcPlatform.ts → handleWindowUnreadCountSync
    │  windowUnreadCountMap（每窗口计数；窗口关闭时清理）
    ▼
syncApplicationUnreadBadge(map)                     desktopWindowLifecycle.ts
    │
    ├─ darwin / linux → app.setBadgeCount(total)            （既有行为）
    └─ win32         → 对每个 BrowserWindow 调 setOverlayIcon(数字徽章) + 托盘数字徽章
```

统计与同步链路三平台共用；只在主进程"最后一公里"按平台分叉。

## Windows 实现

Electron 在 Windows 通过 `BrowserWindow.setOverlayIcon(image, description)` 支持任务栏角标（Shell `ITaskbarList3::SetOverlayIcon`）。与 `setBadgeCount` 不同，**overlay 不负责渲染数字**，必须自绘徽章图。

- **位置**：overlay 由系统固定绘制在任务栏按钮右下角（与 Windows 更新盾牌、Outlook 同步状态同一机制），API 无位置参数，无法绘制右上角效果；右上角只在托盘角标上可行（自绘可控）。
- **观感（1.5.0 数字徽章）**：任务栏 overlay 绘制带数字的红色圆形/胶囊徽章：1–9 显示单个数字，大于 9 显示 `9+`。按 Windows 固定显示尺寸提供原生 1x（16×16）与 2x（32×32）`NativeImage` representation，各自在目标像素网格上用手工设计的位图数字（1x 为 3×5 点阵、2x 为 6×10 粗笔画点阵）居中绘制，白字、纯红底、4× 超采样抗锯齿边缘、无描边；单数字为圆，`9+` 横向拉成胶囊以保证每个字形至少 1px 间距。徽章铺满画布（不再缩成 7px 小红点），保证 16px 下数字可辨认。Win10/Win11 共用同一张图：数字徽章占满画布，不存在旧红点的锚点偏移问题。无障碍 description 携带具体数量（如 "3 tasks need attention"）。
- **托盘角标**：Windows/Linux 托盘（`Tray`）在应用图标右上角合成与任务栏同款的数字徽章（同一像素渲染函数，1x 约 10px 高、2x 约 20px 高），数字与任务栏一致；提供原生 1x（16px）与 2x（32px）表示。计数变化时 `tray.setImage` 换图，归零恢复原始多分辨率图标；macOS 无托盘（平台返回 null），由 Dock 角标承担。
- **多窗口**：所有窗口统一显示全局未读总数（与 macOS Dock 显示应用级总数一致，符合"完成了几个会话就显示几"的直觉）。无任务栏按钮的窗口（CUA 指示器、更新状态窗等 skipTaskbar 窗口）设置 overlay 无副作用，不单独排除。
- **清零**：`count = 0` 时任务栏传 `null` image 移除角标，托盘恢复原图。
- **性能**：角标只在"任务完成 / 用户查看任务"时变化，更新频率为事件级；徽章图按 label 缓存在内存，单次更新是一次查表 + 一次 Shell 调用 / 一次托盘换图。
- **无障碍**：overlay `description` 传静态英文描述（主进程无 i18n 管线，v1 不做本地化）。

## 平台矩阵

| 平台                  | 机制                                                 | 状态                       |
| --------------------- | ---------------------------------------------------- | -------------------------- |
| macOS                 | `app.setBadgeCount`（Dock 红色数字，同一计数）       | 已上线，计数语义 1.5.0 扩展 |
| Linux（Unity/KDE 等） | `app.setBadgeCount`（LauncherEntry D-Bus）+ 托盘角标 | 已上线，托盘角标为本文新增 |
| Linux（原生 GNOME）   | 系统无 badge API                                     | 托盘角标兜底（本文新增）   |
| Windows               | `BrowserWindow.setOverlayIcon` + 托盘角标            | 本文新增                   |

## 测试与验证

- 单测：计数（未读 ∪ 等待去重、确认后不计、签名变化重新计入、不可见项目排除）、label 解析（0/1~9/10+）、数字徽章 16/32px 渲染（白色字形像素存在且左右对称落在画布内、`9+` 两个字形不粘连、圆外透明）、预乘 alpha 混合、托盘换图（红点合成、清零恢复原图、无托盘 no-op）、win32 分支对 `setOverlayIcon` 的调用（含清零传 null、多窗口、跳过已销毁窗口）、darwin/linux 分支仍走 `setBadgeCount`。
- 手工验收（Windows）：完成任务或出现审批 → 任务栏图标右下角出现数字角标，托盘图标右上角出现同一数字；打开任务 → 双双递减；全部读完 → 消失/恢复原图；多窗口显示同一总数。
- E2E：任务栏 overlay 与托盘图均为 OS Shell 渲染，WebDriverIO 无法断言，以单测 + 手工验收覆盖（验收记录见 MR 描述）。

## 边界与已知限制

- 窗口最小化到任务栏时 overlay 仍可见（本需求场景）；若未来支持"关闭到托盘"，隐藏后 overlay 不可见，需另行在托盘图标上提示。
- 移动 Web 远控端无任务栏概念，不适用；桌面端角标统计包含远控 workspace 的未读任务（同一 renderer store）。
