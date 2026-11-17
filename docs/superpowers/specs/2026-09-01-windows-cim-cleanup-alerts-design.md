# Windows CIM 进程清理与告警降噪设计

## 目标

在 Windows 10 及以上环境中移除 WMIC 进程查询后端，统一使用 PowerShell `Get-CimInstance Win32_Process`，并将 Agent 进程清理的 error 告警收敛到最终重试失败，减少 `runtime process tree cleanup incomplete` 的误报警，同时保持 PID reuse 防护和 fail-closed 安全边界。2026-11-17 的 Task27 将当前规范收束为逐边证明归属、固定候选、定向当前身份复核和 exact PID 信号；该日期的规格更新不是实现或运行通过记录。

## 非目标

- 不改变 `transport_ready` / `functional_ready` 两阶段 Helper 启动协议。
- 不允许仅凭裸 PID 发信号。本 services/process 清理链所有 graceful、force、root 例外和默认
  runner 均禁止 `/T`；其它独立 CLI/平台路径不因文本命中而机械修改。
- 不引入 Windows Job Object；该方案另行设计。
- 不扩大 Windows 进程清理 deadline。

## 设计

### CIM capability

Local Host 生命周期内维护 PowerShell/CIM 能力状态。首次全量 CIM 查询即完成真实能力确认并缓存结果，不额外启动一次探测进程；能力探测必须验证 `powershell.exe` 和 `Get-CimInstance Win32_Process` 的真实可调用性，而不是只检查可执行文件存在。

能力状态至少区分：

- `cim`：当前 Host 可执行 CIM 查询。
- `identity-unavailable`：PowerShell 不存在、被策略阻止或本轮查询不可用。

硬失败可以在 Host 生命周期内缓存；单次 timeout 不得永久污染后续 cleanup，仍需允许下一轮重试。

### Process snapshot and force verification

ProcessManager 仍是 Agent spawn 唯一 owner，Transport 持有原始 child、可信 exit、首快照和
cleanup attempt；Ownership 解析固定成员，Terminator/Waiter/Runner 沿原路径调度和完成。
不增加公开 API、常驻扫描、第二 owner 或第二接受状态。

Agent cleanup 首次发现使用一次异步全量 CIM 查询，保存 `pid`、`parentPid` 和 canonical
`CreationDate`；失败也不立即补扫。同步入口必须满足相同发现规则，异步生产清理不改成同步。
sync/async 均使用 `windows-utc-100ns:<unixTicks>`，由 .NET ticks 减 Unix epoch 偏移得到
BigInt；不截断来源精度，不经毫秒比较，不用 epsilon。来源只有微秒精度时不声称新增精度。
本次没有已知持久化旧 token 合同，不增加猜测式兼容分支。

root 锚点须唯一且可解析，有可信 spawn 起点时不能早于它。每条可见父子边必须满足
`child.created >= directParent.created`，合法相等保留。时间缺失/错误、重复 PID、循环及其
依赖分支 fail-closed，不能穿透或通过另一条未证明路径重新认领。root 已退出或在查询期间
观察到退出时，不能采用同 PID 当前行；仅由真实事件的可信 `[spawn, exit)` 恢复所有候选，
再逐边校验。边界须是非负安全整数毫秒且 `spawn < exit`，转换为 BigInt ticks；查询完成时间
不得代替 exit，上界不包含相等时刻。同步阻塞造成的尚未投递 exit 仍是观测限制。

首快照是固定候选 K，当前匹配 M 仅是本阶段证据。live root 只给原受管 root exact graceful，
绝不直接把旧 snapshot 后代当作 graceful 当前目标。root-exited 路径可在预留窗口对已登记
集合定向过滤，matched 才 exact graceful；短窗口及最终 retry 跳过这一步，直接开始有验证的
force。force 仍从全部未证明退出的 K 复核，不能只复核前阶段 M；reparent 不改变创建身份归属。

后代仅在当前阶段 PID+CreationDate 匹配后允许 `taskkill /PID <pid> /F`；graceful 命令为
`taskkill /PID <pid>`。原受管 root 保留既有受限例外：未进入 `unverifiedRootOnly`、未证明
换代、真实 spawn child 尚无 exit、句柄可用且 PID 存活，最多只作用原 root 单 PID，并同样
受命令截止约束。只有旧快照、裸 PID 或带 kill 方法的任意对象不能启用；该例外不授权后代。
外部 taskkill 仍按数值 PID，不能宣称原 ChildProcess 对象让它原子地使用了原句柄。

验证内部须区分 matched / gone / unknown。成功完整批次证明缺失/创建身份不同，或明确 ESRCH
才证明原身份 gone；失败、超时、解析歧义、未查询及非 ESRCH 探测错误均 unknown。初始
root-exited 过滤失败不能让 K 消失或使 waiter 以空 currentIdentities 成功；unknown 留在
remaining 责任中。root exit 只解决 root，不替所有已登记 child/grandchild 退出背书。

```text
Host init
  -> CIM capability (cached)
  -> cim / identity-unavailable

Agent spawn (ProcessManager)
  -> cleanup起点固定deadline (Transport)
  -> one full CIM discovery: root anchor + each parent edge
  -> fixed candidates K + canonical CreationDate

cleanup
  -> EOF + live-root exact graceful / root-exited matched exact graceful
  -> targeted CIM batches within original absolute deadline
  -> matched: exact taskkill /PID n /F
  -> original managed root still live: root-only exact fallback
  -> gone: 原成员完成，不认领新身份
  -> unknown: 不发信号，保留固定成员并观察至deadline
  -> unverifiedRootOnly: no handle fallback，观察原child
  -> Waiter: 全部完成证据 / remaining + 保留ownership
```

### 有界批量与时间合同

规范公式及事件图以 [Windows状态机](../../windows-agent-process-cleanup-state-machine.md) 为准：

- transport 首轮 `D=t0+3250ms`，最终既有 retry `D=tr+1250ms`（forceAfter=0）；retry复用
  首快照且不重复EOF宽限，直接force，不新增重试或超时。无 transport deadline 的公开调用
  也从原入口固定 `entry+F+L+G`，初始查询计入，
  不在 waiter 重新起算。L 是原命令上限，G 是原观察上限。
- force 在 `s=max(now, nominalForceAt-750)` 开始。`R=max(0,floor(D-s))`，
  `O=min(G,floor(R/3))`、`V=min(750,floor((R-O)/2))`、`C=min(L,R-O-V)`；
  `V+C+O<=R`。验证至 `s+V`，命令至 `D-O`，观察至 D。750ms 只是上限；小于750ms
  仍准入有界验证。命令 timeout 重新取剩余窗口，异步回调晚到不得发新信号或续时。
- 快照50ms+EOF1800ms 后 force余150ms，但 D 仍余1400ms，分配575/575/250；最终retry
  满余量分配500/500/250。验证慢或窗口不足时保留未决成员，不假报清理成功。
- root-exited 初始过滤截止为 `min(now+750, nominalForceAt-750, D)`；无正余量便直接走
  force，不加前置串行查询。graceful/force 每身份每阶段至多查询一次。
- 每个定向批次最多64 PID，一个 CIM OR filter，每个 cleanup attempt 定向并发上限1；
  18项一批，129项最多64/64/1三批，共用同一阶段绝对截止。失败批次unknown，不重试或
  退回全表，已完成匹配批次不被一项失败拖成无目标。多workspace保持既有并行收口。
- PID 须为安全整数 `1..4294967295`，仅序列化校验后的数值，禁止拼入外部字符串；
  出界/小数/非有限值在CIM和runner边界拒绝。结果重复、坏行或不完整不能伪装成缺失。
- 确认 matched 后的PID探测仅用于观察；OS拒绝访问不是不存在。unknown仍预留潜在命令预算，
  不可因空匹配集切到短纯观察并释放ownership。全部unavailable且没有固定候选时才保留
  既有原ChildProcess纯观察分支；成功只证明此有限责任，不保证所有未知后代已退出。

### Alert policy

`cleanupManagedProcessWithRetry` 的第一次失败只记录可恢复的 `warn` 并保留原始错误；retry 成功时最终 cleanup 视为成功，不产生 error 告警。只有 retry 也失败时，才记录一次最终 `error`，并保留最终错误作为返回值。

## 验收标准

1. 代码和测试中不再启动 `wmic.exe`。
2. WMIC 不存在时不再产生 `wmic.exe ENOENT` warning。
3. PowerShell/CIM 可用时全量快照、定向身份复核和 force 行为保持正确。
4. `identityVerification: "unavailable"` / `unverifiedRootOnly` 路径仍 fail-closed，不发送裸
   PID 信号；受管 live root 例外只能作用于 root exact PID，不能通过 `/T` 扩散到未复核后代。
5. cleanup 第一次失败、retry 成功时不产生最终 error；两次失败只产生一次最终 error。
6. 相关 Windows 单测和 Agent process manager 单测通过。
7. 回归测试覆盖定向 CIM 复核失败时的受管 root-only `/F` 兜底，以及
   `unverifiedRootOnly` 下不发送任何 root `/F`。
8. [Task27的17项验收映射](../../testing/1.4.1-gate-repair-spec.md#task27-windows-安全清理的确定性验收)
   全部保留：包含 sync→async组合、逐边精度、短余量、最终retry、合法树活性和root-exited未知
   过滤。所有系统边界先全mock，不增加skip或削弱原业务断言。
9. 默认runner的真实参数和模拟原生扩树effect均受断言；旧含`/T`的负向断言不得因删除参数
   变为恒真，须按目标PID及force语义检查全部命令。安全RED/GREEN及独审后才运行有界自有
   真实子进程；现场Docker/WSL不得参与。

## 保留限制

固定快照后从未登记的晚生后代由Agent自身spawn adapter/EOF收尾承担；本次不承诺Host可靠
发现或清理全部未知进程。系统时钟回拨、来源精度、缺失中间parent，以及身份查询到数值PID命令
之间的非原子竞态仍存在；保守漏认不能以裸PID、epsilon或额外全表扫描补救。
