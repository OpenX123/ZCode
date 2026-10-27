# GitHub 桌面更新

Main 创建一个 updater，拥有清单、当前候选、下载进度与校验缓存。Renderer 只经平台契约发命令并投影状态；不使用 electron-updater、不恢复官方更新或账号服务。实现规则和验收入口见 `docs/desktop/github-desktop-update-spec.md`。

公开入口为 `index.ts` 与 `contract.ts`。`checkForUpdates` 返回检查结果；`downloadUpdate` 仅在用户动作后下载并打开；`installUpdate` 再校验后重开。订阅者收到同一 owner 快照，`dispose` 取消网络并阻止迟到打开。下载文件提交前与打开前都验证 size/SHA，URL 只接受本仓库固定 Release。
