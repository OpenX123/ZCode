# 桌面更新 UI

Main 持有更新状态与安装文件；本模块不比较版本、不自行构造下载结果。本机 AppSettings 仅持久化隐藏候选版本的展示偏好，不复制更新事实。

- Footer 和帮助菜单通过同一个 platform 只读投影订阅更新；最后一个订阅释放时清理监听。
- 先注册监听，再读取快照；期间收到事件就放弃迟到快照。
- 检查、下载、安装副作用只经过 hooks 中的 IPlatformService。
- 已下载动作重试安装，已知版本失败重试下载，未知版本失败重新检查。
- `update-available` 带 `manualDownload` 时（当前平台不在发布矩阵内）动作为 `open-release`：经 `IPlatformService.openExternal` 打开 Main 提供的 releaseUrl，不调用下载；手动检查的 `manual-download` 结果以 info toast 与打开动作提示。
- Web 不挂载更新入口，缺少可选更新接口时保持隐藏。
- 关闭侧栏仅保存当前版本，手动检查/更新恢复展示；设置保存失败可见，跨窗口刷新复用 SettingsChanged。
- 关闭只作用于发现新版与已知版本的下载失败（`isDesktopUpdateDismissible`）；下载中与已就绪状态始终展示且无关闭按钮。
- 侧栏说明按挂载处注入的 `isWindowsDesktop` 区分：Windows 打开安装程序，macOS 自动安装并重启。
