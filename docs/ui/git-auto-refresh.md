# Git 自动刷新

## 背景

顶部 Git 操作入口和底部 Git 分支切换器都依赖 `useGitRepository` 读取的
`GitRepositorySummary`。历史实现只在 workspace 切换、Git pane 打开、用户手动刷新，
以及 Git 操作完成后重拉状态；如果用户在外部编辑器修改文件或切换分支，UI 会停留在旧状态。

## 实现

`useGitAutoRefresh` 在当前 workspace 可见且 Git 可用时，根据 workspace Host 的平台和
`gitSummary.autoRefreshWatchPaths` 注册 `fileWatcherService.watch()`。Git service 只返回
Git 自身解析出的 gitdir/common-dir 元数据路径，避免把 workspace 内容路径作为跨端共享的
递归监听事实源；这同时兼容 monorepo 子目录和 linked worktree。

- macOS / Windows workspace：保留 workspace 内容路径的递归 watcher，并补充 Git 元数据路径。
- Linux workspace（包含本地 Linux、SSH、WSL、Docker）：只监听 Git 元数据路径，不递归监听
  整个 workspace。Linux 上的递归 `fs.watch` 需要遍历子目录，在慢挂载或大型生成目录下会
  阻塞 workspace Host，进而延迟 task/session RPC。
- workspace Host 平台尚未返回，或旧 server summary 仍携带 workspace 内容路径时：按 Linux
  的保守策略处理，不注册 workspace 递归 watcher；手动刷新和 Git 操作完成后的刷新链路保持不变。

事件到达后，hook 会做 1 分钟防抖，然后触发现有 `onRefreshGit()`，复用原来的
`gitRefreshVersion` 刷新链路。

## 后台开销约束（2026-11-08）

证据（本机 1.1.0 生产日志，P8）：隐藏实例通宵执行 136 次刷新，每次 4 个 git.exe（p50 251ms）；
多段连续 60.4–60.5 秒间隔（11-04～11-08 同一 Host 最长连续 6 次）；文件树每批监听事件都单独调用 `git.refresh`，
绕过 1 分钟防抖。

### 自激循环（已复现）

`git status` 每次都会机会性地获取 `.git/index.lock`（stat 信息过期时还重写 `.git/index`）。临时仓库
（Git 2.55 / Windows）实测：index 已是最新时，一次刷新的 4 个命令中只有 `status` 产生文件事件，`.git`
递归 watcher 收到 `index.lock` 的创建/删除，workspace 递归 watcher 收到 `.git\index.lock` 与 `.git`，文件树
根目录的非递归 watcher 收到 `.git`。旧实现把这些当成变化，于是每次自动刷新都会在 60 秒后安排下一次刷新，
周期 = 60s 防抖 + 150ms Host watcher 防抖 + 命令耗时，与日志里的 60.48s 链一致，且永不收敛。

修复后：`status` 以 `GIT_OPTIONAL_LOCKS=0` 运行，index 最新时整轮刷新不产生任何事件；index 的 stat 信息
过期（例如文件被 touch）时，`git diff`（工作树对 index）仍会回写一次 index（该命令不受此变量控制），
产生 `index.lock` 与 `index` 事件——前者按噪声丢弃，后者按状态文件触发至多一次后续刷新，之后 index 已最新、
不再产生事件。端到端复核（真实 git + 真实 watcher，连续 3 次 `getStatus`）：事件只出现在第一次。

### 规则

- **只读状态命令不取可选锁**：`git status` 以 `GIT_OPTIONAL_LOCKS=0` 运行（环境变量，旧版 Git
  会忽略，不影响远端老 Git），也不会再与用户自己的 Git 命令争抢 `index.lock`。index 的 stat 缓存改由
  `git diff` 或用户的 Git 操作回写。
- **唯一节流所有者**：每个 workspaceKey（`workspaceIdentity?.trim() || workspacePath`）一个
  `GitAutoRefreshScheduler`（`packages/ui/src/lib/gitAutoRefresh.ts`），持有待处理变化、1 分钟防抖计时器
  与 ignored 判定缓存。Git watcher（`useGitAutoRefresh`）和文件树 watcher 批次都只向它报告变化；
  计时到期后它通知全部订阅者：App 的 `gitRefreshVersion` 与文件树的 Git 状态读取。文件树不再按批次
  直接调用 `git.refresh`；用户点击刷新、首次加载与 Git 操作后的刷新链路不变。
- **路径过滤**：
  - gitdir / common-dir 内只保留影响状态的路径：`HEAD`、`index`、`packed-refs`、`config`、
    `info/exclude`、`refs/**`、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`REBASE_HEAD`、
    `rebase-merge/**`、`rebase-apply/**`；`*.lock`、`objects/**`、`logs/**`、`FETCH_HEAD`、`ORIG_HEAD`、
    其他 worktree 的 `worktrees/**` 以及 gitdir 目录自身的事件都忽略。
  - 工作树路径按 Git 的 ignore 规则过滤：命中已缓存的 ignored 路径（或其祖先）直接丢弃，不重置防抖；
    未知路径在计时到期时用一次 `gitService.getIgnoredPaths` 批量判定（含祖先目录，缓存最浅的
    ignored 祖先），全部 ignored 则跳过本轮刷新。`.gitignore` / `info/exclude` 变化清空缓存并刷新。
  - 事件没有 `changedPath`（旧 Host 合并批次、平台不给文件名）时保守刷新。
- **Host 递归 watcher 逐路径上报**：递归 watch 的一个 150ms 批次按不同路径各发一个带 `changedPath`
  的事件；超过 32 个路径时逐级折叠为祖先目录直到不超过上限（折叠后的 `changedPath` 表示“该目录下有变化”）。
  无法得知文件名时仍发一个不带 `changedPath` 的事件。非递归 watcher（文件树、预览等）语义不变。
- **窗口不可见时暂停**：以 `document.visibilityState` 为唯一事实，不另存可见状态。`hidden` 时不启动
  防抖计时器、不刷新，只累积变化；回到 `visible` 时若有累积变化立即补刷一次，没有变化不刷新。
- **仓库解析缓存**：`resolveRepository` 缓存成功解析的仓库布局（`rev-parse` 结果），每次复用前用两次
  `stat` 确认 `<repoRoot>/.git` 与 gitdir 仍存在；非仓库与 Git 不可用的结果不缓存，`invalidate` 清除。
  一次刷新由 4 个 git 进程降为 3 个。

```text
Git watcher(event.changedPath) ─┐
                               ├─> GitAutoRefreshScheduler[workspaceKey]
文件树 watcher 批次(dirPath) ───┘      │ 分类：噪声/ignored 丢弃；状态路径/未知路径记入 pending
                                      │ visible：重置 60s 计时器；hidden：只累积
                                      ├─ 计时到期或回到 visible ─> 仅有未知工作树路径？
                                      │      是 → getIgnoredPaths 一次 → 全部 ignored 则结束
                                      └─> 通知订阅者：App gitRefreshVersion+1、文件树 loadGitStatus
                                             （两路并发 refresh 在 Host 复用同一次 getStatus）
```

这条链路覆盖：

- macOS / Windows 外部编辑器修改、创建、删除文件后，顶部 Git 操作入口重新判断 dirty 状态。
- 所有平台的外部命令切换分支、提交、stage/unstage 后，底部分支名和 push/commit 入口同步更新。
- Linux workspace 的工作树外部编辑不会由 workspace watcher 触发即时 dirty 刷新；用户可手动刷新，
  ZCode/Git 操作完成后的既有刷新链路不变。
- 远程 workspace 继续通过 workspace-scoped services 注册 watcher；WSL/SSH/Docker 的平台事实
  来自远端 Host 的 `systemService.info()`，不能使用桌面端平台判断。远程断连或平台不支持
  watch 时，监听失败只记录 warn，保留手动刷新和操作后刷新链路。

## 取舍

这里没有使用固定间隔轮询。轮询会在大仓库和远程 workspace 上持续产生 Git CLI/RPC 开销；
事件触发只在文件系统实际变化时刷新，更适合桌面端和 Web 远控共享的工作区模型。

## 大仓库状态降级

`git status --untracked-files=all` 的详细输出可能因为缓存目录或生成产物包含上万个未跟踪文件而
超过 Git 命令的输出预算。此时不能直接放大预算：详细状态返回后还会逐个读取未跟踪文件统计行数，
会把一次 UI 刷新放大成上万次并发文件读取。

Git repo 在首次发现详细状态超限后，必须对当前 `repoRoot` 做运行期能力降级：

- 重新执行 `git status --untracked-files=normal`，把未跟踪目录折叠成目录级记录，保证分支、
  tracked change、dirty 状态和可操作的未跟踪入口仍能返回。
- 同一个 repo 实例内后续刷新直接使用折叠模式，不再重复触发一次必然超限的详细命令。
- 降级只按实际路径语义的 `repoRoot` 建 key，不使用 `workspaceIdentity`；不同远端 server 的
  Git service 进程天然隔离。
- 正常规模仓库仍使用 `--untracked-files=all`，保持逐文件展示语义不变。
- 第一次降级记录一条 `warn`，后续刷新不重复刷相同告警；折叠模式仍超限时继续按真实失败处理，
  不解析被截断的 Git 输出。
