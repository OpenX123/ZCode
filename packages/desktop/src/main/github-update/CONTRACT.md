# GitHub 桌面更新

Main 创建一个 updater，拥有清单、当前候选、下载进度、校验缓存与自动更新偏好的运行值。Renderer 只经平台契约发命令并投影状态；不使用 electron-updater、不恢复官方更新或账号服务。实现规则和验收入口见 `docs/desktop/github-desktop-update-spec.md`。

清单和安装包使用独立的 Electron Session 并跟随系统代理，默认 TLS 校验不变；不能借用默认强制直连的模型 API 会话。适配器只持有一次网络初始化 flight，失败可重试，不修改其他会话的代理或证书策略。

公开入口为 `index.ts` 与 `contract.ts`。`checkForUpdates` 返回检查结果；自动检查（`manual=false`）在 `autoCheck` 关闭时直接返回当前结果。检查得到可自动安装的新版本且 `autoDownload` 开启时后台下载并校验，完成后为 `update-downloaded`，后台失败恢复 `update-available` 不发布错误。`downloadUpdate` 只下载校验；`installUpdate`（“重启以更新”）再校验后以 `restart` 模式交接；`installOnQuit` 在应用正常退出时以 `quit` 模式交接，不抛错、只交接一次。`setPreferences` 即时调整定时器与后台下载。macOS 适配器负责同卷准备与独立助手（quit 模式不确认、不再触发退出、替换后不启动），Main 注入现有退出确认和 update-install 屏障，成功交接后不重入；Windows 以 `/S --updated [--force-run]` 静默运行 NSIS 安装器，启动失败回退打开交互安装器。订阅者收到同一 owner 快照，`dispose` 取消网络并阻止迟到交接。下载文件提交前与交接前都验证 size/SHA，URL 只接受本仓库固定 Release。清单合法但没有当前平台/架构安装器时，候选只含版本与 releaseUrl，状态为带 `manualDownload` 的 `update-available`，检查、下载、安装均返回 `manual-download`，不请求其他架构安装器，也不后台下载。
