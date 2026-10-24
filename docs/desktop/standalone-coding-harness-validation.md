# 独立桌面 Coding Harness 验证记录

日期：2026-10-24。源码与验收边界见 [规格](./standalone-coding-harness-spec.md)。本轮不提交、推送或发布；测试使用隔离目录，不迁移日常用户数据。

## 环境与证据

macOS arm64，构建 Node 24.14.0、pnpm 10.33.2。日志位于本地 `.git/standalone-validation/`，不进入版本库。普通 API 测试使用合成凭据与本地回放，没有使用用户真实 API Key。

工作区另有并行 YCode 品牌改名，本轮保留且不扩展该改动。产物名称反映实际工作区身份，不代表本次商业剥离主动更名。buildCommitId 是工作区基准提交，不代表已提交的发布版本。

## 静态检查与受影响单测

| 检查                                | 实际结果                                            | 日志                      |
| ----------------------------------- | --------------------------------------------------- | ------------------------- |
| `pnpm typecheck`                    | 通过，包含桌面 E2E 类型                             | `typecheck-final14.log`   |
| `pnpm lint`                         | 通过，0 errors / 94 warnings                        | `lint-final11.log`        |
| `pnpm architecture:check --changed` | 0 违规，baseline 0                                  | `architecture-final9.log` |
| 显式选择的受影响根单测              | 121 文件、1709 项通过；非根全量                     | `changed-root-final7.log` |
| 删除无消费者的构建标记后 env 回归   | 3 项通过，普通环境与 Preview 身份保留               | `retired-env-tests.log`   |
| `pnpm test:unit:affected`           | 选中 1638/1638，按仓库合同跳过，未执行测试          | `affected-final5.log`     |
| 本轮文件格式                        | 通过，覆盖本轮根与 CLI 文件                         | `fmt-task-final6.log`     |
| `pnpm fmt:check`                    | 未通过；1979 文件存在格式差异，含已证明的 HEAD 存量 | `fmt-final6.log`          |
| `git diff --check`                  | 通过                                                | `diff-check-final4.log`   |

没有为规避检查而提交、暂存、重置或全仓格式化。根格式存量证据见 `fmt-baseline-proof.log`：`.agents/skills/ai-elements/SKILL.md`、`third-party/npm-overrides.json`、`packages/zcode-server-cli/test/cli.test.ts` 的内容等于 HEAD，当前格式器仍要求修改。受影响测试脚本按显式文件集合运行，未调用根全量单测。

## 行为回归

下表按独立命令列出，覆盖有重叠，不合计为全仓通过数。

| 范围                                  | 结果与覆盖                                                                                                      | 日志                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Built-in 本地只读与 Personal Provider | 47 文件、428 项通过；内置目录只读随包文件，无远端同步与旧缓存回退                                               | `provider-local-source-tests-final.log`                                   |
| CLI 运行链退役                        | 15 文件、343 项通过；旧 Provider 失败不切模型，普通流恢复、预算、工具结算、compact、取消、Memory 和本地统计保留 | `cli-final-fallback-tests.log`、`cli-final-observability-tests.log`       |
| CLI 实际 emit 构建                    | contracts → adapters → core → bootstrap 全部通过；37 个源文件 lint 无告警                                       | `cli-final-*-build.log`、`cli-final-source-lint.log`                      |
| 工具与 Bash 去空遥测                  | 12 文件、241 项通过；权限、取消、Hook、deadline 与本地资源统计保留                                              | `ui-tool-observation-*.log`                                               |
| 目标完成验证                          | 普通 Provider/nextAction/取消/usage 21 项筛选回归通过，139 项未选择                                             | `ui-target-verifier-*.log`                                                |
| 反馈入口与历史保留                    | 6 文件、98 项通过；旧 metadata/正文只读，复制与派生保留                                                         | `ui-feedback-*.log`                                                       |
| 更新设置退出                          | 3 文件、41 项通过；硬件加速、通知、终端与 App Usage 保留                                                        | `ui-update-settings-green.log`                                            |
| 工作流目录同步                        | 两项先红后绿；合并草稿/默认目录/可用性/同步共 4 文件、70 项通过，覆盖旧响应迟到                                 | `workflow-catalog-red.log`、`workflow-catalog-green.log`                  |
| 默认插件与 SSH 旧缓存                 | 21 项 resolver/故障测试、48 项 CLI 插件测试通过；旧下载描述符无法恢复原厂二进制下载                             | `source-server-retired-cache-green.log`、`image-search-default-tests.log` |
| 生产与测试内置目录                    | 6 文件、30 项通过；普通 GLM/BigModel 等模板保留，40 条旧套餐规则退出                                            | `builtin-retired-rules-green.log`                                         |
| 远程桌面升级出口                      | 2 文件、152 项通过；提示手动安装兼容构建，保留 Server 更新                                                      | `ui-desktop-update-green.log`                                             |

删除功能的专属测试随实现退役。通用凭据、MCP OAuth、模型绑定、排队/停止/编辑、耗时与历史读取断言迁到保留场景。CLI 巨型测试文件仍有存量 lint 告警，额外全 CLI lint 的 `product-projection.ts` 超长文件错误未扩修，不记为全 CLI lint 通过。

## 桌面回放

核心回放使用 bridge 测试构建 `desktop-final-build5.log`；工作流复跑使用 build6，最后的独立桌面场景使用最新完整源码构建 `desktop-final-build7.log`。权限生产逻辑没有本轮修改。

- 核心回放 `e2e-final-core4.log`：compact 1 项、stop/queue 5 项、续聊/停止 1 项、Subagent 7 项、CronCreate 1 项通过。模型输出来自回放；文件、终端、权限、Subagent、Cron 工具与 SQLite 持久化实际运行。
- 权限首轮 3 项通过、2 项失败：长文本输入后的焦点/选择断言失败，后续同规格受未关闭交互影响。生产 `PermissionDialog` 无此次修改；补失败诊断后，独立复跑 5 项全部通过（`e2e-final-permission-recheck.log`）。未放宽断言；首轮失败根因尚未确认，不把整轮写成全部通过。
- 最终 pending 回放：匿名空配置、普通 GLM 模板保存及重启恢复 2 项通过；配置独立性 1 项通过；工作流关闭 1 项通过（`e2e-final3-*.log`）。
- 工作流关闭再恢复默认的场景先在测试 helper 误等聊天页时失败；修正为等待设置退出并复用已显示的自动化页后，1 项通过（`e2e-final-workflow-return-recheck.log`）。保留 Host/catalog 屏障及入口显隐断言；对应 helper 3 项先红后绿（`ui-automations-return-{red,green}.log`）。最终复跑使用 `desktop-final-build6.log` 的完整重建。

最后一次完整重建后，`e2e-final4-standalone-coding-harness.log` 的 2 项再次通过，新增无模型提示只引导配置模型 API、没有套餐/升级/登录文案的断言。

H07 的资源管理器观测在打开窗口后采样十秒；`dropped=0`、官方业务请求为零。配置独立性用例观察冷发送、续发和重启续聊，官方 `/client/configs` 请求为零。这些观测没有覆盖所有进程从启动最初一刻开始的完整网络窗口，不等同全部 H07 已完成人工验收。新场景保留在 `manual-review/pending`，未自动转正或准入正式 CI。

## 构建与隔离安装包

最新完整源码构建 `desktop-final-build7.log` 通过，覆盖 Agent、Server 和四平台 SSH 资源。随后通过 `desktop-production-build-final3.log` 重新编译无测试桥接的生产桌面；`desktop-package-final4.log` 打包、原生资源、依赖闭包和体积审计均通过。macOS arm64 产物未签名，未提交、上传或发布。

首次 DMG 辅助工具从 GitHub 下载中断；从镜像获取同版本工具后，核对其 SHA-256 与 electron-builder 固定值一致，通过 `CUSTOM_DMGBUILD_PATH` 使用它完成打包，没有修改工具依赖或下载原厂 Agent。证据为 `dmg-tool-verified.log`。

`runtime-artifacts-final3.log` 检查 55 个退休 CLI 源文件，旧编译输出为零；四份归档的 size/hash 全部匹配，退役遥测与官方鉴权模块为零。资源准备先 Server、后桌面完整 Agent 与插件，避免后续清空暂存目录。Windows Koffi 只保留真实 Agent 依赖，macOS 不再要求过时 CUA 副本。

体积审计维持基础 500 MiB；离线资源每平台最多 112 MiB、合计最多 400 MiB。只有当前版本的严格四平台清单、文件白名单、size/hash 与无符号链接校验全部通过，才按实际归档字节增加额度。当前验证资源约 335 MiB，总额度约 835 MiB。该折算基于预压缩归档原始字节，不是精确的压缩后桌面拆账；独立运行审计而不提供离线资源时仍执行原 500 MiB 限制。

| 产物                         |      字节数 | SHA-256                                                            |
| ---------------------------- | ----------: | ------------------------------------------------------------------ |
| `YCode-3.16.2-mac-arm64.dmg` | 551,074,287 | `d0ebec717b4d06232a957cb7bd14f36fbf322c0ee9ddcb4dfa25f648139c3a38` |
| `YCode-3.16.2-mac-arm64.zip` | 541,018,124 | `191ee74c1a3b4d43c15825ce044614f37beae23b031632833e3d4006281d758c` |

从最终 DMG 只读挂载并复制应用到临时目录，没有写入 Applications。`installed-assets-check.log` 确认 Agent 与本次源码产物一致、四份 SSH 归档哈希匹配、615 个插件资源与暂存内容匹配、第三方许可存在。插件对照仅排除构建占位 `.gitkeep`、已排除的 sourcemap，并复现既有 afterPack 的 sourceMappingURL 注释剥离。

真实应用使用空白隔离配置启动：直接进入桌面，无登录页；无 Provider 时保留草稿，提示配置模型 API；点击配置进入通用模型设置并提供添加供应商入口；返回后草稿不丢失；`__zcodeSessionStoreE2E` 未注册。证据为 `installed-ui-assertions.json.log`、`installed-settings-assertions.json.log`、`installed-draft-return.json.log` 与 `installed-desktop.png`。

从应用启动时启用的 Chromium NetLog 到上述交互结束，HTTP URL 数量为零（`installed-network-summary.json`）。这只覆盖 Chromium，不包含全部 Node/Agent 进程；不能替代全进程 H07 验收。应用、隔离配置、DMG 挂载、SSH 服务和临时密钥均已清理，日常用户数据未改动。

## 隔离 SSH

使用本机回环 sshd、临时密钥与可信生成的 host key，启用 StrictModes 和 StrictHostKeyChecking；没有外部服务器写入。

`ssh-loopback-final6.log`：四归档 size/SHA-256 校验、SCP darwin-arm64、解压、归档 Node 执行 Agent、Server 3.16.2 启动、新 SSH 连接查询 ready、停止均通过。资产来自最后完整重建 `desktop-final-build7.log`；生产 renderer 随后移除测试桥接，运行时资源保持该次重建。这是真实本机 SSH 与 Server 进程证据，不等同外部 Linux 或桌面 workspace 身份全链路验收。

## 未取得的证据

真实模型 API 计费调用、外部 Linux SSH 主机、Windows/Linux 桌面实机与全启动网络窗口尚未验证。没有使用真实账号或日常用户数据，不能用本地回放、归档生成或 macOS 运行结果替代这些证据。
