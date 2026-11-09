# ACP 体验改造验证记录

日期：2026-11-09。以下主体记录 Task1–4 的历史实现与定向验证，桌面候选仍为 pending。最新 Composer 合同与 Task5 新截图以文末 Task5 追加段为准；Task4 截图不代表最终输入区布局。

## 范围与环境

- 规范：`docs/desktop/external-agent-engines-spec.md` 的 ACP 体验实施合同，AX01–AX07。
- 工作分支：`codex/acp-connection-experience`；保留开工前未提交改动，没有提交或推送。
- 固定工具链：Node 24.14.0，按 `mise.toml`；本机系统 Node 24.18.0 且未安装 mise，验证使用经官方 SHA256 校验的独立 Node，不修改全局环境。
- 外部引擎限定现有桌面本地 Claude Code / Codex。模型响应与连接竞争测试使用隔离夹具，不使用真实凭据。
- 桌面候选保持 `manual-review/pending`，没有自动转正或准入 CI。

## 验证结果

| 范围                       | 实际结果                                                                                                                                                 | 证据边界                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置与诊断                 | 定向 4 文件 55 通过、1 个平台条件跳过；审查修复后 service/UI 2 文件 49 通过、1 跳过                                                                      | 覆盖主从切换、独立加载、profile 认证隔离、Dialog、取消与迟到快检；含本地 CLI API Key 不宣称远端认证通过的回归                                                                                             |
| Composer 与连接偏好        | 定向 10 文件 165 通过；审查修复后 3 文件 38 通过；两轮代码审查通过；实际 Electron 定向通过                                                               | 覆盖引擎分段、Fast 更多、连接偏好/迟到确认隔离、首发屏障、断连后再次发送收口、远程原因可读取，以及 Enter/Esc/焦点返回；桌面范围见下文                                                                     |
| 备用准备与窗口资源         | strict 修复后 adapters 最终分次覆盖 80 通过 / 3 平台条件跳过；bootstrap 34 通过；Host 11 通过；shared 4 通过；两个 CLI 包类型检查通过                    | 独占预留、取消、迟到进程、身份/环境/入口失效、窗口许可与真实进程树关闭后的 revoke ACK 顺序；原 P1 已修复，独立复审 Spec/Quality 均通过。80 项为分次最终覆盖，保留中间失败及预算修正记录，不改写成单次全绿 |
| 桌面交互                   | 四份候选聚焦 9 场景；run5 为 7 passed / 2 failed，修正后 run6 为 3 passed / 0 failed；9 个不同场景均有最终通过证据                                       | 真正 Electron 41.0.3 / Host / CLI / stdio，供应商由隔离夹具替代；没有将分次覆盖写成单次全绿；候选未转正                                                                                                   |
| 最终类型、Lint、架构与格式 | 根 typecheck 退出 0；根 lint 退出 0，91 警告/0 错误；根最终 architecture 退出 0（violations/baseline/new 均 0）；桌面 typecheck:e2e 与五文件定向格式通过 | Node 24.14.0 / pnpm 10.33.2；根架构日志 `.scratch/acp-runtime/acp-final-architecture.log`，桌面类型日志 `.scratch/acp-runtime/task4-typecheck-e2e-final-source.log`；`git diff --check` 退出 0            |

## 真实桌面运行与修正

所有命令均从仓库根执行，以固定 Node 运行 `scripts/mise-run.mjs pnpm --filter @zcode/desktop test:e2e`；使用 `ZCODE_E2E_MANUAL_REVIEW=1`、隔离 fixture bin 和 runner 生成的隔离 HOME。targeted runner 每轮重新构建 desktop/CLI，没有设置 skip-build。最终 replay 显式指向 `packages/desktop/test/e2e/fixtures/upstream/common.json`，不需要真实供应商地址或 API Key。

| 运行             | 实际结果与依据                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| connections run1 | exit 1；Electron 已启动，beforeAll 因 manual-review 默认 capture 缺供应商地址拦截，产品断言未执行。日志 `.scratch/acp-runtime/task4-connections-run1.log`                                                                                                          |
| connections run2 | 显式 replay 后 1 failed / 0 passed；连接实际创建成功，旧“默认”断言与当前“上次使用”文案不符。核对 locale 后同步测试。日志 `.scratch/acp-runtime/task4-connections-run2.log`                                                                                         |
| targeted run3    | exit 255；Windows mise-run 的 shell 将 CLI grep 正则管道解释为命令，测试未启动；改用现有 `ZCODE_E2E_MOCHA_GREP` 环境变量。日志 `.scratch/acp-runtime/task4-targeted-run3.log`                                                                                      |
| targeted run4    | exit 1；现有 Turbo 构建入口的 `run --force build:desktop-agent` 参数解析失败，测试未执行；回到既有默认 pnpm 构建路径，未改构建源码。日志 `.scratch/acp-runtime/task4-targeted-run4.log`                                                                            |
| targeted run5    | exit 1；9 场景 7 passed / 2 failed。通过设置、not-ready、计划/502、网关终态/Claude计划、P11首发屏障、两家首发/续聊/Fast拒绝/冷恢复、停止恢复。新增布局查询误中隐藏旧 pane；旧 native 候选没有应答阻塞式权限帧。日志 `.scratch/acp-runtime/task4-targeted-run5.log` |
| clean run6       | exit 0；3 passed / 0 failed / 0 skipped，3 spec 均通过。布局按当前 pane 查同样的矩形边界；native 复用真实权限批准 helper，保留原子会话类型/数量/标题与父正文隔离断言；设置在清理环境后重拍。日志 `.scratch/acp-runtime/task4-clean-run6.log`                       |

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

## Task5 最终 Composer 验证

本段替代前文Task1–4历史截图对Composer最终布局的描述。输入区无任何连接入口或标签；草稿三引擎分段在上方，既有会话仅固定灰Logo；项目、真实位置与Git分支位于编辑器上方同一行；底部左附件/权限、右单个模型/深度入口与发送/停止，Fast位于合并弹层更多。单个EngineControls持有配置弹层owner，继续使用原配置确认、拒绝、迟到ACK与首发屏障。

统一命令前缀P为 `C:/github/ZCode/.scratch/acp-runtime/node-v24.14.0-win-x64/node.exe scripts/mise-run.mjs pnpm`。Task5主要定向UT6文件125/125，新增同owner互斥及空深度目录两项回归后picker最终22/22；这些分次记录没有改写成单次全量。空effort+有效model/Fast先2 failed/20 passed，再修入口可打开条件为22/22，打开不写、选择回传原始value。UI `tsc -p packages/ui --noEmit`、最终desktop `typecheck:e2e`、精确源码格式与architecture changed均exit0，架构violations/baseline/new均0；根typecheck/lint由根代理最终汇总。DEP0190、pnpm配置迁移、jsdom canvas、SQLite实验特性及构建chunk/plugin耗时提示仍存在，不宣称无告警。详细命令与逐轮结果见 `.superpowers/sdd/2026-11-09-acp-experience/task-5-report.md`。

每轮仍重新构建desktop/CLI；runner子进程清除供应商ambient前缀，仅设置example网关，HOME/profile隔离，ACP供应商由本地stdio夹具替代。Task5 run2为2 passed/2 failed，其中P11首发记忆屏障、两家18项模型/首发/续聊/运行中Fast拒绝/冷恢复通过，失败为本地文案与Windows视口断言准备；run3 AX03/07通过、Codex430被原最小窗宽钳制，修复夹具最小宽准备后run4深度pending/拒绝1/1通过。run5为真实Git分支等待失败：Electron启动后才在HOME内init的仓库投影仍为祖先checkout分支；checkout HEAD未变，无测试提交。只在Git init后通过已有完整进程树退出屏障重启Electron/Host，不修改Git产品代码或加轮询。具体缓存归因未确认。

最终Task5 run6（不是前文Task4 run6）为exit0、AX03/AX07 1/1 passing、case32.1秒，日志 `.scratch/acp-runtime/task5-e2e-run6.log`；真实Git分支、四种宽度/主题、键盘焦点、首发与固定Logo全部通过。根证据目录为 `C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109190447363-p39412-4e818cea4584fc2a/`：

- `task5-composer-1280-light.png`、`task5-composer-1280-dark.png`
- `task5-composer-640-light.png`、`task5-composer-640-dark.png`
- `task5-model-effort-fast-popover.png`、`task5-fixed-engine.png`
- `task5-layout-1280-light.json`、`task5-layout-1280-dark.json`、`task5-layout-640-light.json`、`task5-layout-640-dark.json`

6图已逐张查看；4份JSON的头行文本均为 `ZCodeProject / 此电脑 / composer-layout`，头行中心差小于0.001 CSS像素；宽/窄头行bottom450.045/441.643均低于编辑器top468.616/460.214；模型与发送之间留4像素。Windows缩放下1280/640请求对应1281/641 CSS视口，沿用既有尺寸helper±1容差；640时复用紧凑图标和长名省略。Task4全部Composer图及Task5 run3图仅为历史，不能替代本组最终截图。候选仍pending；真实SSH、供应商性能及全量桌面/根UT未运行。

根代理在最终E2E退出后完成最终根 `P typecheck` exit0（`.scratch/acp-runtime/acp-task5-final-typecheck.log`）及 `P lint` exit0、91 warnings/0 errors（`acp-task5-final-lint.log`）；精确范围diff检查exit0。空深度P2独立scoped复审通过，无新增Important。6张最终截图已复制至前文visualizations交付目录的同名`task5-*`文件，原始产物和历史截图均保留。整体最终评审由根代理收口。

## 最终整组审查与修复验收

整组审查发现并一次集中修复四项：Host 撤销失败的 Promise 需允许同许可重试；A→B→A 返回缓存 CLI 时依前台/可信可见事实恢复候选，后台读取不抢占；真实 Codex `fast-mode` 和 `collaboration_mode` 归入合并弹层更多，仅权限常驻；官方登录后由 Host 广播更新后的安全连接视图。唯一增量复审确认 F1–F4 均 ADDRESSED，Spec compliant / Quality Approved，无新增 P1/P2。报告保留于 `.superpowers/sdd/2026-11-09-acp-experience/final-review.md` 与 `final-fix-report.md`。

三份定向测试先红后绿，最终 68 passed / 1 skipped；另路由测试 16 passed。最终桌面 AX03/07 内嵌真实 `fast-mode/on` 原值提交与拒绝保持 Off，1/1 passed、无 retry，case 42545ms；Electron/Host/CLI 真实进程，供应商仍是隔离 stdio 夹具。最新根 typecheck exit0、lint exit0（91 warnings / 0 errors），日志 `.scratch/acp-runtime/acp-final-wave-typecheck.log` / `acp-final-wave-lint.log`；精确格式、定向 lint 与架构检查通过。根通过不覆盖前文四个未修改 CLI max-lines 的包级失败，也不扩大真实供应商/SSH/POSIX 覆盖。

本轮最终原始产物：`C:/github/ZCode/packages/desktop/.e2e-artifacts/desktop-e2e-20261109193901894-p54820-c77a1653e9bb3239/`。六图与四份矩形 JSON 已复制到前文交付目录，使用 `final-fix-*` 文件名，替代 `task5-*` 作为整组最终证据。弹层图显示 Fast mode Off 与 Collaboration mode Default 均在更多；四张布局图保留刚验证拒绝产生的预期提示“配置修改未生效，请重试”，不是运行失败，弹层与固定引擎图中该提示已自然消失。图与数据均已查看，候选仍为 manual-review/pending。

最终检查时发现其他操作已在分支提交 `1f7e7266`，本会话与实施代理没有执行提交或推送；保留该提交及后续未提交修复。整组审查始终比较开工基线 `4f367fab` 到最终工作区，未因并发提交遗漏产品差异。
