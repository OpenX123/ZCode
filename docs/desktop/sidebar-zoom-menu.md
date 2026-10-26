# Sidebar Zoom Menu

## 背景

桌面端已经通过 View 菜单和 `Cmd/Ctrl + +/-/0` 支持页面缩放，内部档位为 `[-3, 5]`，每档倍率是 `1.1 ^ level`。侧边栏头像菜单之前移除过旧的 `zcode-zoom-level` localStorage 偏好；后来恢复的轻量菜单只复用当前窗口系统缩放命令，导致用户通过菜单或快捷键调整后，下次重启又回到默认大小。

## 目标

- 在桌面端侧边栏头像菜单中展示 `Interface zoom` 二级菜单，展开后包含 `Zoom In`、`Zoom Out`、`Actual Size` 三个命令。
- 菜单项执行现有 `DesktopCommandIds.ZoomIn` / `ZoomOut` / `ResetZoom`，并把成功后的桌面缩放档位保存为 `AppSettings.desktopZoomLevel`。
- 主窗口创建时在 main 进程读取已保存档位并先应用到 `BrowserWindow.webContents`，让首屏、macOS 红绿灯位置和 Windows 标题栏控制区使用同一个缩放事实源。
- 菜单禁用态与 View 菜单一致：最大 `+5` 档禁用 `Zoom In`，最小 `-3` 档禁用 `Zoom Out`，默认档禁用 `Actual Size`。
- renderer 通过 platform 能力读取并订阅当前桌面缩放档位，确保快捷键或顶部菜单触发后 sidebar 菜单状态也能同步。

## 非目标

- 不改变 Web / 手机端浏览器自身缩放能力。
- 不改变 Web 远控 replayable 恢复链路，也不向远控链路增加 zoom 状态。
- 不恢复旧的设置页 Interface zoom 偏好或 `zcode-zoom-level` localStorage 读写。
- 不把手机 Web 远控的 replayable 恢复语义扩散到桌面端 continuous 主链路；缩放偏好只影响桌面端 BrowserWindow。

## 实现

### 底部入口

- 左侧「设置」文字与齿轮组成一个主按钮，点击直接打开完整设置页；设置页复用时显示返回箭头和「返回工作区」。
- 右侧使用滑杆图标，名称及提示为「快捷偏好」，只展开现有语言、主题、界面模式和桌面缩放菜单。不得与主入口同时展示齿轮或使用相同可访问名称。
- 复用原有导航回调、偏好更新与桌面缩放命令，不新增状态所有者。窄侧栏、深浅主题与中英文均保留两个入口的可操作性。

### 缩放链路

- `packages/shared/src/platform.ts` 定义 `DesktopZoomState` 和 `IPlatformService` 的桌面缩放读取/订阅能力。
- `packages/shared/src/channels.ts` 增加 `GetDesktopZoomLevel` 与 `DesktopZoomLevelChanged` 平台频道。
- `packages/shared/src/protocol.ts` 与 `packages/shared/src/validationAppSettings.ts` 增加 `desktopZoomLevel`，允许旧配置缺省并按 `[-3, 5]` 接收持久化档位。
- desktop main 在缩放命令成功后向对应窗口发送最新档位，写入 `setting.json`，并继续刷新原生 View 菜单禁用态。
- desktop main 启动读取 `AppSettings.desktopZoomLevel`，创建窗口时通过 `initialDesktopZoomLevel` 传入窗口创建流程。
- desktop preload 缓存最新档位，提供 `getDesktopZoomLevel` / `onDesktopZoomLevelChanged`。
- `WorkspaceSidebarFooter` 仅在 `isDesktop` 时显示 `Interface zoom` 二级菜单，并复用现有 View 菜单命令文案；头像菜单恢复原有显示偏好顺序：`Language`、`App theme`、`Interface zoom`。
- 桌面系统 View 菜单的可见缩放项顺序与 sidebar 二级菜单保持一致：`Zoom In`、`Zoom Out`、`Actual Size`。

## 验证

- `settings-ui-polish.test.ts` 的 UP-01 覆盖主设置与快捷偏好的不同名称和图标、快捷菜单原有顺序、进入完整设置页及通过返回箭头回到工作区。

- 单元测试覆盖缩放命令成功后写入 `desktopZoomLevel`，以及窗口创建时先应用持久化缩放。
- `pnpm typecheck`
- `pnpm lint`
