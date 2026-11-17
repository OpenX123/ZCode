# Agent Shutdown Latency

## 背景

桌面 App 退出会进入 `before-quit`，main process 等待各 workspace window 的 Local Host 以及仍存活的 Remote Host 完成资源回收。每个 Host 再等待其按 workspaceKey 托管的 ZCode CLI 进程树退出，避免 `zcode-cli` / `app-server` / MCP 子进程在 Windows、macOS、Linux 上残留。

2026-06-12 的运行日志显示，普通关闭从 `waiting for host process cleanup` 到 `host process cleanup completed` 约 2.4s 到 2.7s。静态代码确认主要原因是 `terminateProcessTreeAndWait()` 固定等待 `DEFAULT_FORCE_AFTER_MS + DEFAULT_WAIT_AFTER_FORCE_MS`，即使 agent 进程已经提前退出也不会立即返回。

## 目标

- 正常关闭时优先让 stdio agent 收到 EOF，自行完成协议入口的 shutdown 和 sqlite/session store 收尾。
- 进程已退出时立即结束等待，不再固定吃满 2.25s 兜底窗口。
- agent 无响应时仍按进程树强制回收，防止 runtime/MCP 子进程残留。
- Agent 正常运行期间的 stdio request / response / notification / stderr 热路径不得查询系统进程表；进程清理只能影响退出耗时，不能改变消息吞吐、顺序或 UI 实时性。
- 保持桌面端 `desktop-continuous` 主链路语义；本变更只影响 app 退出后的 host 资源回收，不改变手机 Web 远控 `web-remote-replayable` 的 stream/snapshot/queue 边界。

## Windows 普通退出与更新安装预算

Windows 普通退出属于高频交互，更新安装属于低频且必须释放随包资源锁的严格交接，两者不再
共用同一等待预算：

```text
普通退出 / 重启                    更新安装
  -> Cron 与 Host 并行 dispose       -> Cron 与 Host 并行 dispose
  -> 4s 后强制结束 Host             -> 7.5s 后强制结束 Host
  -> 总屏障最多等待 4.5s             -> 总屏障最多等待 9s
  -> 退出 App                       -> 扫描并清理随包资源引用
                                     -> quitAndInstall
```

- Windows 普通退出包括窗口关闭、托盘退出和普通应用重启；它不执行更新安装的随包资源锁扫描。
- Cron Scheduler 的 1.5 秒收口必须与 Host 清理并行，并纳入同一个退出 Promise；不得先等待
  Cron 再启动 Host timer，否则阶段预算会串行累加为约 6 秒/10.5 秒。Cron 一进入 disposing
  状态必须停止向正在退出的 Host 派发新任务。
- Windows 普通退出的短预算只适用于 Local Host。SSH/WSL/Docker/Bot Remote Host 的关闭
  还包含最长 1 秒的 service dispose 与最长 6 秒的 remote connection dispose，Main 必须继续
  使用 7.5s/9s 严格预算，避免在 Host 既有关闭上界前强杀；该预算是兜底上界，远程 Host
  提前退出时不会固定等待至超时。
- `auto-update quitAndInstall` 必须显式选择 `update-install` policy，继续保留 7.5s/9s 严格屏障。
- 若更新请求晚于已经启动的普通退出，它不得因为无法延长既有 4s timer 而拒绝安装：更新类型
  升级为 `update-install`，尚未调度的清理使用严格预算；既有短屏障完成后继续执行 Windows
  资源扫描并 fail-open 启动安装器。产品接受此极端竞态下可能残留 runtime，更新可达性优先。
- macOS/Linux 暂不缩短，避免把本次 Windows 性能修复扩散到未采集运行时证据的平台。
- 普通退出的 4s 强杀点仍晚于 Host 内部 3.5s 的 service/process-tree 有界清理；不得直接降到
  该内部边界之前，否则可能在 `taskkill` 兜底执行前终止 Host 并重新制造孤儿 runtime。

## 实现约束

- `ZCodeStdioTransport.disposeAndWait()` 先关闭 stdin，触发 `app-server --stdio` 的 input close 路径；短窗口内未退出再进入进程树终止。
- `ZCodeStdioTransport.disposeAndWait()` 必须在发送 stdin EOF 前保存进程树快照；否则根进程先退出后，已脱离或被系统接管的后代无法再通过 PPID 找回。
- 协议先失效，stderr reader 保留到流关闭，child exit 后最多再 drain 250ms，再用旧 runtime 身份生成 exit tail。仅 stderr 失败不关闭健康协议。
- 普通 EOF 宽限为 1800ms，覆盖 CLI 自首个关闭事件起 1500ms 的总退出上限；等待仍扣减原进程树总预算，重复信号不续时。coverage 保留独立的写盘宽限。
- `ZCodeStdioTransport` 的 `send()`、stdout frame 分发和 stderr line 分发只负责协议 I/O，不得调用同步或异步的 `ps`、PowerShell、`taskkill` 等进程管理命令，也不得依据消息 method/type 猜测何时刷新进程树。退出快照只允许在 `dispose()` / `disposeAndWait()` 已开始后获取。
- 进程所有权来自 Host 的 spawn 关系和 Agent 自身的 MCP/process adapter，不来自协议消息活跃度。POSIX Agent 必须继续运行在独立进程组；Windows 以本次合法固定的创建身份集合为 Host 清理边界。Agent 正常 EOF 收尾负责先关闭其登记的 MCP 进程树，Host 的退出前快照与有身份门禁的 exact PID 信号负责 Windows 强制兜底。
- `terminateProcessTreeAndWait()` 的完成边界是“回收前快照中已归属该 runtime 的成员全部确认退出”，不是仅直接 child 退出。根进程先退出时，已登记后代仍须取得原预算内的身份复核与 exact force 机会；未知身份保留观察责任。`remainingPids` 同时承载已知存活和未能确认退出的固定成员，调用方不能把 warning、查询超时或空匹配列表当成 cleanup 成功。
- cleanup timeout 不证明原成员已经退出。观察预算内稍晚投递的正常 exit 仍可成功；到截止时，仍存活或退出事实未知的固定成员均报告 `cleanup incomplete`，日志区分这两种原因：

  ```text
  退出前身份快照 -> graceful / force 回收 -> 终态观察预算
                                            |-- 快照身份全部退出 -> success（含 late exit）
                                            `-- deadline 时存活或未知 -> remainingPids + 保留 ownership
  ```

  Windows 的快照、EOF、taskkill 和终态观察共享 transport 固定绝对 deadline。只有完全
  unavailable、无固定候选且 root 例外不适用时，才进入原 `ChildProcess` 的既有纯观察分支，
  有效截止直接遵循[状态机公式](../windows-agent-process-cleanup-state-machine.md#force-验证命令观察分配)：
  显式 transport D 下为 `min(D,waiterStart+max(remainingForce+G,750))`。750ms 是既有最终
  retry 的纯观察上限，不是所有 `M=[]` 情况的总等待上限。只要 K 仍有未决固定身份，即使
  初始过滤全部 unknown、M 为空，也保留 L 命令预算与 force 复核机会，不能仅因此提前 settle。
  纯观察最终 retry 与首轮 3.25s 的最坏组合不超过 Local Host 的 4s 强制退出点；有固定候选
  的路径继续沿用原 taskkill 绝对 deadline。macOS/Linux 的既有 POSIX force + observation
  上界不变。

- 进程树快照不能只保存裸 PID：必须同时保存可复核的进程创建标识（Linux `/proc` start ticks；Darwin `lstart + command + PGID`；Windows `CreationDate`）和 POSIX PGID。Windows sync/async 统一为 `windows-utc-100ns:<UTC Unix epoch 起的整数 ticks>`，保留 CIM 经 .NET ticks 输出的全部精度，用 BigInt 比较，不降为毫秒或添加 epsilon。来源只提供微秒时，该编码不增加真实精度。首次发现必须先验证 root 锚点，再逐条要求 `child.created >= directParent.created`；早于父节点、身份不可解析、循环或重复 PID 的歧义节点及依赖分支全部拒绝，合法同精度相等保留。
- live root 的创建时间不得早于可信 spawn 起点；root 已退出（含查询期间退出）时不能采用同 PID 当前行，只能由真实 exit 事件提供可信 `[spawn, exit)`。边界须为非负安全整数毫秒且 `spawn < exit`，转换为 BigInt ticks 后比较；所有恢复候选仍限制在该生命周期内，并逐边验证，不扩展到 root 退出后新生孙代。同步入口也遵守该规则，查询完成时间不得代替 exit。同步阻塞期间尚未投递的 exit 是观测限制。
- 首次合法快照是固定候选，不是发送时的当前证据。live root 只对原受管 root 发 exact graceful；EOF 前旧快照不得直接授权 descendant graceful。root 已退出时，只有本阶段定向过滤为 matched 的成员可发 exact graceful；短余量时跳过该前置 graceful 阶段并直接进入有验证的 force。所有仍未确认退出的已登记后代（含 reparent）都保留 force 验证资格，不能只从上一阶段 matched 子集挑选。
- 本 services/process 清理链的 graceful、force、root 例外和默认 runner 全部禁止 `taskkill /T`。只使用 `taskkill /PID <pid>` 或 `taskkill /PID <pid> /F`，不得让原生命令重新扩树。受管 root 例外只作用于调用链传入的原始 spawn `ChildProcess`：未进入 `unverifiedRootOnly`、未证明身份换代、尚未观察 exit、句柄可用且 PID 存活；只有裸 PID、旧 snapshot 或具有 `kill` 方法的任意对象不能证明该前提。该例外也受命令绝对截止约束。外部 taskkill 仍按数值 PID 执行，不能宣称它使用了 ChildProcess 的原句柄。
- Windows 后续身份验证只查固定候选 PID；每批最多 64 个、一个 `ProcessId = n OR ...` CIM filter，同一受管进程/固定快照 cleanup 链（含最终 retry）的底层活动查询并发上限 1，所有批共享本阶段验证绝对截止，每身份每阶段至多查询一次。旧查询未确认物理结束时 retry 只能观察并等待其占用释放；等待计入原 D2，随后由新 attempt 自身调度重核占用、截止和实际余量，不复用旧阶段身份结果。旧 callback 只收口旧资源，不能自行调度新查询或信号；不增加全局 Host 队列或第二 owner。18 项必须一批；超长集合不能开 N 个 PowerShell、补全表或失败重试。PID 只能由已校验的系统整数序列化，详见 [Windows 状态机的预算和结果合同](../windows-agent-process-cleanup-state-machine.md)。
- 验证内部结果必须区分 matched、gone 和 unknown。只有成功且完整的定向响应证实原身份缺失/换代，或明确的 OS 不存在证据，才将原成员视为 gone；超时、权限错误、无法解析或未查询均为 unknown。初始 root-exited 过滤若全部未知，也必须保留固定成员及命令预算，不能因 `currentIdentities=[]` 提前成功。历史成员的当前 PPID 改变不影响创建身份复核。
- 系统进程表暂时不可用且尚未取得 root 创建标识时，本轮回收必须 fail closed：不得通过 `ChildProcess.kill()` 或 `taskkill` 向裸 PID 发信号，也不得在延迟 force 阶段重新发现该 PID 的进程树。快照必须显式标记 `identityVerification: "unavailable"`，在既有退出预算内继续观察原 `ChildProcess`；截止时仍未退出则通过 `remainingPids` 报告 cleanup incomplete，禁止把空身份误报为清理成功。
- Agent 的“当前可复用 protocol client”与 Host 的“尚未确认退出的 OS 进程所有权”是两种状态。protocol close 可以立即解除 workspace 的 active client 绑定，但只有 cleanup 确认 root 与已登记树成员均退出后才能释放进程所有权。
- timeout、protocol close、workspace restart 和 app quit 对同一 managed process 的回收必须幂等；失败的 cleanup Promise 不能永久缓存。app quit 必须等待 active 与正在退休的全部 owned process，并对先前报告残留的进程树执行一次直接进入 force 阶段的有界最终重试。该 retry 复用首快照且不重复 EOF 宽限，root 仍活也不能先耗尽 1250ms 再进入 force。
- Windows 在 EOF 前只做一次完整进程表发现，之后使用固定成员的定向验证与 exact PID 信号；root 已退出时仅按上述可信生命周期恢复成员。Windows 10+ 统一使用异步 PowerShell `Get-CimInstance Win32_Process`，多个 workspace 仅可共享晚于各自 spawn 起点的 in-flight 发现查询；不可用时显式进入 unverified fail-closed。POSIX 继续使用 Host spawn 时拥有的独立进程组和已发现后代进程兜底。
- Windows 对多个 workspace Agent 执行 `taskkill` 时必须使用异步子进程并行等待，禁止用
  `spawnSync` 串行阻塞 Host 事件循环。Host 的 service phase timeout 必须能在清理命令卡住时
  准时触发；异步命令仍需设置单次超时，并在 graceful/force 命令完成后返回明确清理结果。
- Windows 退出快照统一异步执行 `Get-CimInstance Win32_Process`；同一轮多个 workspace 共享一个
  in-flight 查询。查询耗时计入原有 force deadline，不得在查询结束后重新开始计算，否则机器负载
  较高时会把进程表查询时间额外叠加到退出预算。每个 cleanup attempt 链只允许首次发现使用
  完整进程表，成功或失败后均不得补扫；Transport 的最终 retry 复用首快照，只做定向复核。
- 首轮 transport 绝对截止仍为 `t0 + 2000 + 1000 + 250 = t0 + 3250ms`；既有最终 retry
  仍为 `tr + 0 + 1000 + 250 = tr + 1250ms`，不新增 retry。750ms 仅是验证上限，
  不是准入门槛。按状态机定义，在 `s=max(now, nominalForceAt-750)` 令 `R=max(0,floor(D-s))`，
  分配 `O=min(原观察预算,floor(R/3))`、`V=min(750,floor((R-O)/2))`、
  `C=min(原命令上限,R-O-V)`，满足 `V+C+O<=R`。验证截止 `s+V`，命令截止 `D-O`，
  终态截止 `D`；实际发送前重新核对截止，命令 timeout 不超过剩余命令窗口。
  快照 50ms 加 EOF 1800ms 后虽只余 force 150ms，仍有 `R=1400,V=C=575,O=250`；
  最终 retry 直接验证，满余量时 `R=1250,V=C=500,O=250`。不能把验证返回时刻当作新起点续时。
- PowerShell/CIM 命令成功但没有可解析身份、被拒绝、不可用或超时时，返回
  `identityVerification: "unavailable"`，空身份不得表示清理完成。root 在同轮查询期间退出时，
  只有调用方已经提供可信的 `ownedProcessExitedAtMs`，或能在查询完成时从受管 ChildProcess 的
  exit 事件读取该时间，才允许按同轮完整进程表恢复后代；查询完成时间不得代替退出上界。
- 关闭路径日志必须是低频生命周期日志，不能记录 stdio 原始帧或 streaming delta。

## 非目标

- 本轮不修改 Main / Host 的 Dispose 消息协议、app-server 信号处理或启动时孤儿进程扫描。
- 本轮不增加常驻进程轮询，也不从运行期消息流推断进程所有权。当前 MCP adapter 不使用 detached spawn，并在 Agent EOF 收尾时显式回收已登记的 stdio MCP 进程树；若未来新增需要脱离 Agent 进程组的托管进程，必须在对应 spawn adapter 中增加显式 ownership/close 契约，不能恢复运行期进程表扫描。
- 本轮不改变 workspace 与 active Agent 的复用关系，不改变 MCP 配置及 session 连接语义。
- 本轮不改变桌面端 `desktop-continuous` 与手机远控 `web-remote-replayable` 的消息交付边界。
- 固定快照之后从未登记的晚生后代不在本次 Host 清理保证内，由 Agent 自身 spawn adapter/EOF
  收尾负责；不得以取消 `/T` 后仍能可靠覆盖所有未知进程为承诺。系统时钟回拨、来源精度、缺失
  中间父节点，以及身份查询到数值 PID 命令之间的非原子竞态仍存在，不能通过宽限或裸 PID 补树放开。
- 本次只修当前 services/process 可达链；不改变无关 CLI/平台 taskkill、POSIX 组、owner/lease、
  workspaceIdentity 或远端语义。安全确定性全 mock RED/GREEN 和独立审查完成前，不运行真实进程回归。
