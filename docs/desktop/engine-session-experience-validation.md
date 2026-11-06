# 引擎性能与会话体验实施记录

日期：2026-11-06。基线：`main`，与 `origin/main` 同步；变更尚未提交或发布。原有四处插件市场改动保留。

## 已实现

| 范围           | 最终行为                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发送与连接     | Host 合并诊断并缓存；发送使用不启动 CLI 的安装门禁，复用健康连接。Windows 检测与执行共用 PATH、PATHEXT、npm shim 和 bundled CLI 解析。默认引擎确定后才预热，过期草稿准备不得启动会话。                               |
| 提交反馈与计时 | 提交立即呈现冻结输入预览；ACK 失败恢复草稿。首内容前区分引擎启动与等待模型；沿用 TTFT 事实，记录提交呈现、命令收到／准入、引擎准备及原生 prompt 起点。                                                               |
| 连接配置       | Codex 支持沿用 CLI、独立目录的官方登录、官方／Responses 兼容网关 API Key。会话绑定不可变配置引用；Key 走既有凭据服务和私有 `providers/set`，不进入普通快照、argv 或协议输入日志。管理连接清除继承的 Key 和网关地址。 |
| 默认引擎       | 本机设置保存最近显式选择，新草稿继承；已有草稿和会话保持原配置。SSH 的设备偏好仍由本机设置持有。                                                                                                                     |
| 计划与错误     | 原生文档、步骤、审批和权限事件进入现有持久投影；审批只回原生选项。第一次已知重试即展示安全错误摘要、HTTP 状态和请求 ID，提供复制，终态清理活动重试，不自动重发 prompt。                                              |
| 更新关闭       | 按待更新版本保存关闭状态，重启及设置同步后继续隐藏；手动检查恢复展示；关闭不停止下载。                                                                                                                               |
| 会话操作       | 标题和侧栏共用复制深链、同目录 Fork 和新工作树 Fork。Main 解析／缓冲链接，Host 精确查索引；源／目标 CLI 交接不透明分叉 bundle。原生分叉不可用时明确标注上下文交接。                                                  |
| 分叉与文件保护 | 原子操作 claim 防止多个 Runtime 对同 UUID 重复创建 native child；完成记录可在父会话后来忙碌时重放。导出／导入响应丢失保留工作树供恢复。Git 固定 HEAD，逐字节复制已跟踪内容及非忽略新文件，源文件和 index 不变。      |

所有权及接口详见 [引擎规范](external-agent-engines-spec.md)、[计划与错误规范](native-plan-errors-spec.md)、[深链与分叉规范](session-links-and-forks-spec.md)及 [TTFT 诊断](../trace/local-ttft-diagnostics.md)。

## 验证

- 根 `pnpm typecheck` 通过。
- CLI contracts/core/adapters/bootstrap 的构建及定向类型检查通过。
- 根 `pnpm lint`：0 errors、95 warnings；本次未增加 warning。
- `pnpm architecture:check --changed`：0 violations；`git diff --check` 通过。
- 定向回归覆盖连接诊断与零进程门禁、Windows 入口解析、配置隔离、计划审批／重试脱敏、设置、更新、深链与 Fork、跨独立 SQLite 库导入、跨 Runtime 抢占、Git 内容及暂存区保护。
- 最新 macOS Electron + 受控 ACP 证据：外部引擎 E12（两家引擎、18 项模型、首发／续聊、运行中配置与冷恢复）见 [`desktop-e2e-20261106-092349-133/summary.md`](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261106-092349-133/summary.md)；原生计划、502、默认引擎见 [`desktop-e2e-20261106-092741-119/summary.md`](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261106-092741-119/summary.md)；更新关闭见 [`desktop-e2e-20261106-100326-214/summary.md`](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261106-100326-214/summary.md)。会话菜单、同目录／工作树 Fork 的真实 Git 证据见 [`desktop-e2e-20261106-080534-275/summary.md`](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261106-080534-275/summary.md)。
- 深链的编码、冷启动缓存、第二实例参数解析、精确 workspace identity 与不存在目标反馈由共享／Main／Renderer 定向回归覆盖；在最终 fresh Electron 中，注入 `app.emit("second-instance")` 的跨窗口导航场景未通过，未把它宣称为桌面实机通过，需后续在真实第二实例进程启动路径复核。Fork 导入 ID 冲突保护已用隔离 SQLite 真实覆盖回归验证。
- CLI 默认 Vitest 配置不收集 `src/**/contract.test.ts`；外部引擎 Runtime 的 12 项契约测试使用显式定向配置执行并通过，未将其误算成默认套件覆盖。

CLI 全包 `pnpm lint` 仍有 3 个未修改文件的 `max-lines` 错误：`adapters/src/model/runner-stream.ts`、`bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`、`contracts/src/model/index.ts`；该检查未通过。全库 `pnpm fmt:check` 报告 1970 个文件存在格式差异，未全库重排来掩盖存量问题。

## 验收边界

当前机器为 macOS。Windows P95、冷连接下降 50%、真实官方 OAuth／API Key／第三方网关、SSH 冷启动定位，以及三种引擎实际模型上下文与目标 cwd 的全组合实机验收尚未完成，不能据夹具或单测宣布这些指标达标。

原子 claim 保证相同操作 ID 的跨 Runtime 去重；源会话的空闲 lease 仍属于当前 Runtime。另一窗口已经运行同一源会话时的全局排他和路由尚未形成实机证据，不将单 Runtime 测试表述为跨 Host 全局保证。
