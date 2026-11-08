# Host database startup

Host Worker 是 app 库启动准备的唯一执行者。宿主验证 progress/done/failed 帧后更新启动状态；输入只携带数据库路径。

先读取旧 settings，再调用 project-storage 的启动入口迁移和维护索引，完成后发送 done，失败保留结构化错误及已经提交的迁移事实。所有退出路径关闭 MessagePort。此顺序避免空设置先记账、之后无法再恢复旧项目种子。

构建产物仍为 host/tasksStorageWorker.js，取消、超时及进程代际仍由宿主原有管理器负责；不改变历史 SQL、checksum 或 attachment。

会话库准备 Worker 只在其线程环境中启用 Node 编译缓存（`NODE_COMPILE_CACHE=<应用数据目录>/cache/node-compile-cache`），执行代码与顺序不变；`prepareSessionStorage` 回报分段耗时，`createHostDatabaseStartup` 经 `logStage` 输出每个阶段的毫秒数与枚举（不含路径或正文）。见 `docs/desktop/host-idle-resources-1.1-spec.md` §5。
