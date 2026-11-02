# GitHub 桌面更新

Main 创建一个 updater，拥有清单、当前候选、下载进度与校验缓存。Renderer 只经平台契约发命令并投影状态；不使用 electron-updater、不恢复官方更新或账号服务。实现规则和验收入口见 `docs/desktop/github-desktop-update-spec.md`。

清单和安装包使用独立的 Electron Session 并跟随系统代理，默认 TLS 校验不变；不能借用默认强制直连的模型 API 会话。适配器只持有一次网络初始化 flight，失败可重试，不修改其他会话的代理或证书策略。

公开入口为 `index.ts` 与 `contract.ts`。`checkForUpdates` 返回检查结果；`downloadUpdate` 仅在用户动作后下载并交接安装；`installUpdate` 再校验后重试。macOS 适配器负责同卷准备与独立助手，Main 注入现有退出确认和 update-install 屏障，成功交接后不重入；Windows 打开 EXE。订阅者收到同一 owner 快照，`dispose` 取消网络并阻止迟到交接。下载文件提交前与交接前都验证 size/SHA，URL 只接受本仓库固定 Release。
