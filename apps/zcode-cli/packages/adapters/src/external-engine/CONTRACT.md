# ACP NDJSON adapter

只运行 shared 描述的锁定 ACP adapter。入口经 exec 基础设施启动；NDJSON 限制单行大小，严格 JSON-RPC id 关联，通知串行 await，禁止原始 stderr/帧进入日志。session/new/resume 完成后才 prompt；权限选项保持原 id。退出拒绝请求，关闭杀进程树；不读取官方凭据或 transcript。

prepareSession 与 runTurn 共用连接和初始化路径，首次 prompt 复用已准备的会话。Electron Helper 子进程显式设置 ELECTRON_RUN_AS_NODE=1，退出错误包含 code 或 signal。

运行中的 set_config_option 与 prompt 共享同一健康连接；JSON-RPC 业务拒绝只拒绝该配置请求，不关闭连接或取消 prompt，传输失败仍回收连接。

新连接初始化时 configValues 是 Runtime 上次确认的选择；依照 resume 最新目录恢复后再发布 configOptions。缺失值明确失败并关闭失败连接，不能静默回落新会话。

新建 Claude 会话未确认 mode 且原生当前为 default 时，目录支持 auto 才通过现有配置 RPC 选择 Auto；发布原生实际返回值，保留模型限制的调整。已有会话、已确认选择、其他原生模式和 Codex 不应用新建默认值；不写用户 CLI 设置或绕过权限。

prepareSession 是同会话 single-flight 的连接恢复入口：只对连接/超时/internal error 有限退避重试；closeSession 与 signal 中止在途准备和退避。runTurn 只在 prompt 前复用准备，prompt 从不自动重发。恢复协商 resume/load 能力，load 不重放用户正文/工具至回调；保留原 externalSessionId 和已确认配置。未确认 session/new 的失败不自动重发。

错误采用 ExternalEngineConnectionError 与 EngineConnectionFailure；只暴露分类、方法和数值 rpcCode，不暴露原始 message/data/stderr。

POSIX PATH 缺 node 时，为 ACP 子进程补充托管运行时入口，复用当前 Node/Electron Node 模式；不修改系统 PATH 或用户官方 CLI。
