# ACP 体验改造验证记录

日期：2026-11-09。以下主体记录 Task1–4 的历史实现与定向验证，桌面候选仍为 pending。最新 Composer 合同与 Task5 新截图以文末 Task5 追加段为准；Task4 截图不代表最终输入区布局。

## 范围与环境

- 规范：`docs/desktop/external-agent-engines-spec.md` 的 ACP 体验实施合同，AX01–AX07。
- 工作分支：`codex/acp-connection-experience`；保留开工前未提交改动，没有提交或推送。
- 固定工具链：Node 24.14.0，按 `mise.toml`；本机系统 Node 24.18.0 且未安装 mise，验证使用经官方 SHA256 校验的独立 Node，不修改全局环境。
- 外部引擎限定现有桌面本地 Claude Code / Codex。模型响应与连接竞争测试使用隔离夹具，不使用真实凭据。
- 桌面候选保持 `manual-review/pending`，没有自动转正或准入 CI。

## 验证结果

| 范围 | 实际结果 | 证据边界 |
| --- | --- | --- |
| 设置与诊断 | 定向 4 文件 55 通过、1 个平台条件跳过；审查修复后 service/UI 2 文件 49 通过、1 跳过 | 覆盖主从切换、独立加载、profile 认证隔离、Dialog、取消与迟到快检；含本地 CLI API Key 不宣称远端认证通过的回归 |
| Composer 与连接偏好 | 定向 10 文件 165 通过；审查修复后 3 文件 38 通过；两轮代码审查通过；实际 Electron 定向通过 | 覆盖引擎分段、Fast 更多、连接偏好/迟到确认隔离、首发屏障、断连后再次发送收口、远程原因可读取，以及 Enter/Esc/焦点返回；桌面范围见下文 |
| 备用准备与窗口资源 | strict 修复后 adapters 最终分次覆盖 80 通过 / 3 平台条件跳过；bootstrap 34 通过；Host 11 通过；shared 4 通过；两个 CLI 包类型检查通过 | 独占预留、取消、迟到进程、身份/环境/入口失效、窗口许可与真实进程树关闭后的 revoke ACK 顺序；原 P1 已修复，独立复审 Spec/Quality 均通过。80 项为分次最终覆盖，保留中间失败及预算修正记录，不改写成单次全绿 |
| 桌面交互 | 四份候选聚焦 9 场景；run5 为 7 passed / 2 failed，修正后 run6 为 3 passed / 0 failed；9 个不同场景均有最终通过证据 | 真正 Electron 41.0.3 / Host / CLI / stdio，供应商由隔离夹具替代；没有将分次覆盖写成单次全绿；候选未转正 |
| 最终类型、Lint、架构与格式 | 根 typecheck 退出 0；根 lint 退出 0，91 警告/0 错误；根最终 architecture 退出 0（violations/baseline/new 均 0）；桌面 typecheck:e2e 与五文件定向格式通过 | Node 24.14.0 / pnpm 10.33.2；根架构日志 `.scratch/acp-runtime/acp-final-architecture.log`，桌面类型日志 `.scratch/acp-runtime/task4-typecheck-e2e-final-source.log`；`git diff --check` 退出 0 |

## 真实桌面运行与修正

所有命令均从仓库根执行，以固定 Node 运行 `scripts/mise-run.mjs pnpm --filter @zcode/desktop test:e2e`；使用 `ZCODE_E2E_MANUAL_REVIEW=1`、隔离 fixture bin 和 runner 生成的隔离 HOME。targeted runner 每轮重新构建 desktop/CLI，没有设置 skip-build。最终 replay 显式指向 `packages/desktop/test/e2e/fixtures/upstream/common.json`，不需要真实供应商地址或 API Key。

| 运行 | 实际结果与依据 |
| --- | --- |
| connections run1 | exit 1；Electron 已启动，beforeAll 因 manual-review 默认 capture 缺供应商地址拦截，产品断言未执行。日志 `.scratch/acp-runtime/task4-connections-run1.log` |
| connections run2 | 显式 replay 后 1 failed / 0 passed；连接实际创建成功，旧“默认”断言与当前“上次使用”文案不符。核对 locale 后同步测试。日志 `.scratch/acp-runtime/task4-connections-run2.log` |
| targeted run3 | exit 255；Windows mise-run 的 shell 将 CLI grep 正则管道解释为命令，测试未启动；改用现有 `ZCODE_E2E_MOCHA_GREP` 环境变量。日志 `.scratch/acp-runtime/task4-targeted-run3.log` |
| targeted run4 | exit 1；现有 Turbo 构建入口的 `run --force build:desktop-agent` 参数解析失败，测试未执行；回到既有默认 pnpm 构建路径，未改构建源码。日志 `.scratch/acp-runtime/task4-targeted-run4.log` |
| targeted run5 | exit 1；9 场景 7 passed / 2 failed。通过设置、not-ready、计划/502、网关终态/Claude计划、P11首发屏障、两家首发/续聊/Fast拒绝/冷恢复、停止恢复。新增布局查询误中隐藏旧 pane；旧 native 候选没有应答阻塞式权限帧。日志 `.scratch/acp-runtime/task4-targeted-run5.log` |
| clean run6 | exit 0；3 passed / 0 failed / 0 skipped，3 spec 均通过。布局按当前 pane 查同样的矩形边界；native 复用真实权限批准 helper，保留原子会话类型/数量/标题与父正文隔离断言；设置在清理环境后重拍。日志 `.scratch/acp-runtime/task4-clean-run6.log` |

run5 的 afterEach 诊断明确存在隐藏旧草稿与可见当前草稿；没有修改产品布局以消除假失败。native 共用 ACP 帧在 permission 步骤等待 response，原候选只等最终正文，真实 client-messages 没有权限应答；补批准符合既有子权限进入父会话待办的产品 spec，没有删帧或自动允许模型权限。

run5 设置截图发现 ambient provider 路由进入“沿用 CLI”显示，不作为交付截图。run6 仅在 runner 子进程删除 `ANTHROPIC_` / `OPENAI_` / `CODEX_` / `CLAUDE_` / `AZURE_OPENAI_` 前缀变量，再显式设置两份 example 网关；HOME、USERPROFILE 和数据目录仍由 runner 隔离，不修改生产环境/配置。设置场景未安装 adapter；其余 ACP 脚本只做本地 stdio 回放，没有真实模型请求。

本轮 grep 选择 settings、AX03/07、P11、两家首发大场景、原生计划/502、网关终态/Claude计划、停止恢复、not-ready、Codex 原生子智能体共 9 项。prewarm 的独立默认引擎持久化、HTML 预览、深度 pending/拒绝三个用例保留但本轮未单独选中；Claude RFD 桌面和真实 SSH 未运行。编辑新 ID 与已有只读绑定分别经桌面验证；同一个已有桌面会话编辑绑定的组合由 service/CLI UT 单独证明，不扩张成桌面覆盖。

## 干净截图与报告

run6 原始证据目录：`C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/`。该目录的 `summary.md` 记录 3/3 通过及完整生命周期；run5 对应 `desktop-e2e-20261109175550853-p51904-9a1ec76e6c9224d8/summary.md` 保留 7/2 结果。截图均为真实 Electron，1280/640 为 renderer 内容宽度，像素图受显示缩放影响。

交付副本目录：`C:/Users/21132/.codex/visualizations/2026/11/09/01a1c0cf-57fc-7671-943e-d1e7e9bc5c17/acp-experience/`（根代理已复制同名 9 图并查看 settings-wide-light、composer-1280-light、composer-640-dark）。原始截图绝对路径：

- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-settings-wide-light.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-settings-wide-dark.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-settings-narrow-light.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-settings-narrow-dark.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-composer-1280-light.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-composer-1280-dark.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-composer-640-light.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-composer-640-dark.png`
- `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109180710673-p51160-080f84bdf48b3788/acp-fixed-binding.png`

## 性能证据

受控真实 stdio 夹具连续 10 次备用命中，完整 PATH resolver 的额外调用由 20 次降为 0 次；10 个原生会话 ID 各不相同。准备中的备用只由第一个请求独占，第二个新会话独立冷启。窗口许可的 revoke 和真实 close gate 均验证关闭完成后才可重新授权。

这些调用次数、进程数和事件顺序不代表真实供应商连接低于一秒。真实供应商的同环境基准尚未执行。

## 已知边界

- Host 的“运行环境可用”只表示 CLI 与 adapter 可启动；API Key 存在和本地 CLI 登录状态不能替代实际远端模型请求。
- 当前 snapshot 没有独立连接休眠事实，界面不根据 `ready` 或计时器猜测进程是否常驻。
- 功能图新增 ACP 节点与边的 YAML 解析、ID 唯一和新端点检查通过；全图仍有四条既有悬空引用，本次未扩展修复范围。
- CLI 包级 lint 仍失败于四个本次未修改的 max-lines 文件：adapters 的 `fs/index.ts`、`model/runner-stream.ts`，bootstrap 的 `zcode-protocol-v4/conversation-topic-publisher.ts`、`transcript-hydration.ts`。变更源文件的定向 lint 通过，未为通过检查放松规则。
