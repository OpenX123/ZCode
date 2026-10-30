# 2026-10-30 ZCode 官方修复定向同步

来源：[zai-org/ZCode a60ba6a7](https://github.com/zai-org/ZCode/commit/a60ba6a7e5a06742270ca605f5d2cc2766afa7e1)，官方版本 3.17.1。
共同基线为 `3c5b227649371507ddc4eb46ac5133afe6db1cab`；本地起点为 `246cf4dd`（YCode v1.0.2）。
官方本次是大源码快照，全量 merge 预演出现 456 个冲突文件，本次按产品边界移植四组修复。
这不是官方 main 的全量合并，后续同步仍需按共同基线和本记录识别已吸收内容。

## 吸收范围与本地适配

| 分组          | 修复前触发场景与证据                                                                       | 合入后的行为                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话持久化    | 真实 SQLite 回归复现 fork 回滚撤销其他会话更新、并发 fork 失败；新进程读不到被误回滚的写入 | DatabaseSync 事务内部不再 await；对外 Promise、数据库结构和本地兼容字段保持原合同                                                                                     |
| 自动 Git 快照 | 真实仓库回归复现执行 fsmonitor，以及继承 GIT_DIR 后读取另一仓库                            | PATH 解析绝对 git、清洗仓库/配置环境、禁用自动快照的 hooks/fsmonitor/隐式网络；并行只读查询，修复 Windows PATH 与真实路径仓库判断；适配本地 ContextSourcePort/EnvInfo |
| 远程稳定性    | 测试复现认证前 dispose 后握手始终 pending，以及信号/无退出状态被判作成功                   | dispose 主动拒绝在途握手并清除 ready 监听；SSH/WSL/Docker 共享退出码归一化，信号终止和未知状态均失败；保留 close 后收集完整输出                                       |
| 聊天渲染      | 原来每个 token 都全窗分组并创建历史 unit，搜索按 turn key 缓存可能漏掉历史修订             | 按不可变投影数组派生历史/尾段并复用历史；渲染、插件与搜索按相关输入失效；保留本地双栏、滚动记忆、resize、摘要和话题准备消息                                           |

未引入官方账号、套餐、遥测、高速卡、手机远控、Electron 升级、CLI 新生命周期/API、插件新页面能力或上游退役单测的策略。
保留现有本地能力与测试，不改 owner/lease、workspaceIdentity、continuous 传输、数据库 schema 或版本号。

## 验证

使用 Node 24.14.0 / pnpm 10.33.2。以下结果为本机验证，不代表 Windows/Linux 实机或真实 SSH 服务验收。

- 根 `pnpm typecheck` 通过；根 `pnpm lint` 通过，93 warnings / 0 errors。
- CLI `pnpm --dir apps/zcode-cli typecheck` 通过，30 项任务成功。
- `pnpm architecture:check --changed` 通过，0 violations；未扩大架构 baseline。该检查不证明未受管模块的全部运行时语义。
- CLI adapters 精确运行 session-store、transaction-isolation、session-mailbox、session-external-engine、git-snapshot、git-snapshot-hardening、fs-context、exec：236 passed / 3 skipped。包含真实 Git、真实 SQLite、并发事务与跨进程重开。
- 远程后端 sshBackend、closeEvent、dockerBackendDockerCommand、wslBackend：60 passed。
- UI 定向测试覆盖 render units、live tail、find index、插件裁决、滚动记忆、会话切换、话题准备、行共享、导航；补充覆盖历史运行轮时钟、插件手动固定、裁剪和旧历史前插。SessionDataLayer、runtime recycle、transport 与插件 contract 相关 5 个文件另有 128 项通过。
- 真实 React Timeline + TanStack virtualizer 浏览器回归：resize 4 项、stream isolation 4 项通过，覆盖桌面/紧凑布局及深浅主题。使用本机 Microsoft Edge 可执行文件；测试不读取个人浏览器资料。
- stream isolation 实测 5 次 token 更新中，两轮历史 commit 次数保持 1，尾轮从 2 增至 7；同 turn key 的历史正文修订后，搜索命中从 2 降至 1。截图和 JSON 在 ignored 目录 `packages/desktop/.e2e-artifacts/conversation-stream-isolation/`。
- 本次修改的源码与测试格式检查通过，`git diff --check` 通过。CLI 规格保留旧文档原有排版。

CLI 全量 Lint **未通过**：4 个既有 max-lines 错误、66 warnings，另有 7 项原样上游行数诊断被现有规则接纳。4 个错误文件均未由本次修改，且与本地起点内容一致：

- `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- `apps/zcode-cli/packages/contracts/src/model/index.ts`

未执行全量单测、跨平台打包、发布或安装替换。原有标题代码、对应测试和规格继续留在未提交区；其他工作维护中的手机调研文档不纳入本次提交。
