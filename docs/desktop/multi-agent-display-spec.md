# 多智能体展示（YCode 1.1.0，1.3 工作卡更新，1.4 Codex 式行与单一子智能体 Tab）

决策来源：[YCode 1.1 更新方案](./ycode-1.1-plan.md)「多智能体（问题 7）」。本文定义 Renderer 如何把已有的子智能体投影画成头像、胶囊、对话行内子智能体行（1.4 起取代 Subagent 工作卡）、右侧唯一"子智能体"Tab（目录 + 详情）。1.3（W8）在协议上只增加可选的 `model`、`effort`、`toolCallCount`（见"引擎无关合同"第 6 条），不改变 Host、owner/lease 或命令。子会话详情与目录的既有规则见 [Subagent Session Side Tabs](../subagent-session-side-tabs.md) 与 [Subagent Session Directory](../subagent-session-directory.md)，状态胶囊见 [Chat Status Panel](../ui/chat-summary-panel.md)。

## 适用范围与边界

- 三个引擎共用同一套 UI：内置引擎已有子会话；Claude Code 与 Codex 的原生子智能体由 CLI 映射到同一合同（见「引擎无关合同」）。Renderer 不按引擎分支。
- 只读消费父会话 V4 `snapshot.subagents`（`revision`、`childSessionIds`、`running[]`、`endedTotal`）、父会话 `backgroundWorks`、父时间线的 Agent/Task 工具行与 `subagent` 行、子会话自身 snapshot，以及已有的 `session/subagents` 已结束分页查询。
- 除 W8 的三个可选展示字段外不新增协议字段；不新增持久化、不在 Renderer 保存第二份运行态。Workflow 的代理药丸不属于本文，保持 [workflow 展示规范](../dynamic-workflow/presentation.md) 的规则。
- 不在输入框上方新增浮条；实时活动只进右上角状态胶囊。

## 状态所有者

| 事实                                               | 唯一所有者                                                                                                    | Renderer 用法                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 子智能体成员与派发顺序                             | CLI 父会话 ProductProjection 的 `snapshot.subagents.childSessionIds`                                          | 派生头像序号                                                            |
| 运行中成员、`waiting` / `blocked`、`startedAt`     | 同上 `snapshot.subagents.running`                                                                             | 胶囊头像串、智能体分区、详情头部运行态                                  |
| 可停止性                                           | 父会话 `backgroundWorks`（`kind=subagent`、`status=running`、精确 `childSessionId`、`cancellable !== false`） | 智能体分区与详情头部的停止按钮，命令沿用 `cancelBackgroundWork(workId)` |
| 时间线派发与单个智能体状态                         | 父时间线 Agent/Task 工具行与配对的 `subagent` 行                                                              | 子智能体行、旧派发行                                                    |
| 子智能体模型、档位、步骤数                         | CLI 父会话 ProductProjection 写在 `subagent` 行上，`running[]` 项是同值副本                                   | 工作卡成员行（读行）、详情头部模型标签（读 `running[]`，结束后读行）    |
| 子会话结束态与耗时                                 | 子会话 snapshot（`control.phase`、`control.lastError`、`turnHeader` 行）                                      | 详情头部在父会话不再列为运行中时的结束态                                |
| 已结束列表                                         | `session/subagents` 已结束分页                                                                                | 目录                                                                    |
| 派发行展开、计时刷新、子智能体 Tab 的目录/详情选择 | Renderer 内存（选择字段在侧栏 Tab 上，唯一写入路径 `workspaceSidePane.ts`）                                   | 不写入 session、store 或协议                                            |

```mermaid
sequenceDiagram
  participant R as CLI 父会话投影
  participant C as CLI 子会话投影
  participant L as SessionDataLayer（父 / 子 lease）
  participant U as Renderer 各展示面
  R->>L: snapshot.subagents（childSessionIds 追加、running 变化）
  R->>L: rows（Agent/Task 工具行 + subagent 行）、backgroundWorks
  C->>L: 子会话 control / rows
  L->>U: 同一份投影
  U->>U: avatarIndex = childSessionIds 序号（纯函数，不缓存）
  U->>R: 停止：cancelBackgroundWork(workId)（仅投影声明可停时）
```

时序规则：所有展示面在每次投影变化后重新派生，不做延迟、轮询或"自愈"重查；迟到的投影以 `revision` 为准，由数据层保证单调。

## 头像

### 形态

- 沿用瓦片脸（`WorkflowAgentFace`）：代码绘制的 SVG 圆角方块加两只眼，不使用 PNG、字母或散列色相头像。
- 颜色 = `FACE_COLORS[avatarIndex % 9]`（九个固定 HEX），只表示"这是第几个派发的实例"，**从不表示状态**。状态由表情（等待三点、运行竖眼、完成弧眼、失败下垂眼）和旁边的文字/图标表达。
- 轮廓按 `subagentType` 区分种类，16px 下可分辨：

| 变体      | 轮廓             | 类型关键字（不区分大小写，按词匹配，复合词从最后一个词向前找）           |
| --------- | ---------------- | ------------------------------------------------------------------------ |
| `base`    | 圆角方块         | general-purpose、worker、default 及所有未识别类型                        |
| `antenna` | 顶部天线         | explore / explorer / search / scout / find / locate                      |
| `visor`   | 眼部深色护目镜带 | plan / planner / planning / architect                                    |
| `glasses` | 白色方框眼镜     | review / reviewer / verify / verifier / audit / critic / check / inspect |
| `crest`   | 顶部锯齿冠       | test / tester / testing / qa / e2e                                       |
| `ears`    | 顶部圆耳         | research / researcher / investigate / analyze / analyst / study          |

- 例：`Explore` → antenna；`code-reviewer` → glasses；`test-runner` → crest；`statusline-setup` → base。
- 尺寸：16px（子智能体行、对话派发行、Agent 卡图标、智能体分区行）、20px（胶囊头像串、目录行）、24px（右侧详情头部）。三种尺寸使用同一几何，不做降级简化。
- 主题：机身色与眼白在浅色/深色主题相同；头像串的分隔环使用所在表面的背景色（胶囊为 `--color-popover`），随主题变化。
- 动效：右侧详情头部与对话行内子智能体行（1.4）在子智能体运行中时播放空闲表情动作；其他位置静止显示当前表情。`prefers-reduced-motion`、页面隐藏或离开视口时不播放（沿用 `startFaceMotion`）。
- `lib/subagentColors.ts` 的按类型颜色只给 Agent 卡上的类型名文字着色，不得用于头像。

### 序号（avatarIndex）

- 规则：`avatarIndex(child) = snapshot.subagents.childSessionIds.indexOf(childSessionId)`（重复项取首次出现）。
- `childSessionIds` 由 CLI 按当前分支的派发顺序产生：实时路径来自时间线行序，冷恢复种子来自活动分支消息中的工具调用顺序，二者一致，因此序号在重渲染、重连、Renderer 刷新和 CLI 冷启动后不变。
- edit/retry 剪掉旧分支后，被移除的子智能体退出清单，之后的序号随之前移；这是分支变化，不是漂移。fork 继承复制的已结束引用，fork 内序号按 fork 的清单计算。
- 尚未进入清单的派发（子会话尚未登记，或引擎没有子会话的行内兜底）使用临时序号：`清单长度 + 该成员在所属派发行中未登记成员里的顺序`（单个派发为 `清单长度`）。登记后改用清单序号；并发派发的登记顺序可能与工具调用顺序不同，此时颜色可能在登记时变化一次。
- 能算出序号时禁止名字散列；散列只保留给 workflow 中没有实例的车道。

## 右上角状态胶囊

- 收起态只显示一项，优先级：**工作流 > 运行中的智能体 > 计划/进度 > 目标 > Git**，其后依次为已完成目标、已完成进度、进度兜底、终态计划、终端运行数、已结束工作流。
- 运行中的智能体项：`snapshot.subagents.running` 非空（含 backgroundWorks 补齐的同一身份项）时出现，显示最多 3 个重叠头像（20px，按开始时间升序取前三，与展开分区行序一致）和"N 个运行中" / "N running"。N 只数运行中的子智能体，不含终端；只有终端在跑时仍按原规则显示终端计数。
- 点击：展开面板并打开"智能体"分区（与工作流项打开"工作流"分区同理）。按钮的无障碍名称包含数量（"N 个智能体运行中，展开状态"）；头像是身份而非状态图标，悬停时不替换为展开图标，只抬底色。
- 窄宽度下头像串和数量不收缩，胶囊继续受容器宽度上限约束。
- 展开态"智能体"分区：运行项左侧图标换成 16px 头像；标题、已运行时长、停止与"已结束 · N"行为不变。
- 仅有已结束智能体时，不保留没有内容的收起态胶囊；已结束智能体不是 mini 的兜底项。自动模式在窄、宽 conversation 容器下均退场，只有用户显式展开的 panel 仍可单独保留“已结束”目录入口；存在其他摘要时，保持原自动模式和该分区。仅剩已结束工作流时沿既有 mini 优先级保留入口。此规则只影响摘要可见性，不关闭正在查看的子会话详情，不更改事实或停止任务。

Task13 的真实交互验收沿原 Subagent 工作卡 pending 候选，不晋升：SAT31–SAT33 在运行中真实点击切为 mini，取消后分别验证父 summary shell 与活动入口卸载，同一 child tab/header 仍为 cancelled。UX08 默认 auto 在真实父 conversation 容器 `<1280px` 与 `>=1280px` 均卸载 ended-Agent-only shell；通过既有 Side Pane 可见性按钮取得宽度时保留完整 tab 身份，恢复后仍显示同一 child 的 `UX08_RESULT_B`。独立回放的显式 panel 保留已结束目录计数 2、各运行计数 0，再真实“收起为胶囊”后卸载，详情及正文保持。

显式 panel 保留目录可达性，不要求内部 Agent 分区在运行数归零后自动展开；沿既有归零折叠规则，用户展开该分区后可访问已结束目录及计数。

模式只由现有 React UI owner 接受真实点击；CLI/session 投影是终态与计数的唯一事实。测试先核没有 Git/Goal/Todo/计划、运行 Bash/工作流或已结束工作流等其它摘要资格，再断言卸载。父 scope 在打开 child 前保存；任务导航或刷新后按父 session 重新取得唯一可见 pane，不能使用缓存首项或跟随 child 焦点。测试变量 `ZCODE_E2E_TASK13_STATUS_PANEL_VARIANT` 仅允许 `auto|panel`（缺省 auto），只选择独立 runner 的验收分支，不写 store、Fiber 或 props；非法值立即失败。

## 对话行内子智能体行（YCode 1.4，取代 1.3"Subagent 工作卡"）

决策来源：用户确认的"1:1 学习 Codex 桌面版"子智能体交互。1.3 的工作卡外框（"Subagent 正在工作 / 主 Agent 正在协调 N 个委派任务"树形卡、"停止全部"、整卡折叠）退役；数据来源、分组与停止规则不变。

### 分组

- 候选：Agent / Task / subagent 工具调用（已配对 `subagent` 行的 Agent 卡、带外部子工具的 Agent 卡，或尚未配对的 Agent 工具行）。
- 同一轮、在可见工作项列表中**相邻**的候选为一组；中间出现任何其它可见项（正文、思考、其它工具）即断开。
- 组内**任一成员**已配对带 `childSessionId` 的 `subagent` 行时，整组（1 个或多个成员）渲染为**连续的子智能体行**（`presentation=workCard` 名称沿用，组身份仍锚定首个成员的行 `subagentWorkCard:<rowId>`）。组只是一层无样式的容器，不画外框、标题、汇总或折叠箭头。
- 组内没有任何成员带 `childSessionId`（旧会话、外部引擎行内兜底、子会话尚未登记）时保持旧展示：单个派发为 Agent 卡（图标换成头像）；相邻 ≥2 个为一行"A、B 和 C 开始工作"（规则见下文"旧派发行"）。
- 分组只用于实时对话时间线，不改变分享只读时间线。

### 行布局

```
(头像) Backend auth fix  general-purpose   运行中 · 58秒   [■]
(头像) Frontend review                     已完成
(头像) Regression run    tester            失败
       原因：provider 超时
```

- 每个成员一行，整行是原生 button（Enter/Space 激活），`rounded-lg`，悬停 `bg-hover`；连续成员就是连续行，行间 2px。
- 头像：16px `SubagentFace`（DESIGN 头像规则：颜色 = 清单序号，轮廓 = 类型）。成员运行中（running / waiting / blocked）时头像播放空闲表情动作（`animated`），`prefers-reduced-motion`、页面隐藏或离开视口时静止（沿用 `startFaceMotion`）。
- 名称 = 工具调用可见任务标题/描述（CLI 已传有意义的标题，如 "Backend auth fix"）→ 非通用 `subagentType` → 本地化"智能体 N"。`font-medium`，单行截断。
- 类型标签：`subagentType` 去空白后非空、不等于默认值 `subagent`（不区分大小写）且不等于名称时，在名称后显示 `text-ui-xs text-foreground-subtlest` 灰色小标签；按类型的文字色（`lib/subagentColors.ts`）不用于此标签。
- 状态文字（`text-ui-sm text-foreground-subtle`）：运行中为"运行中 · 用时"（每秒刷新，用时取 `subagent` 行 `startedAt`，缺失时只显示"运行中"）；等待确认 / 已阻塞 / 等待启动显示对应状态；已完成显示"已完成"。
- 失败 / 已停止：状态文字为"失败" / "已停止"，原因（`summaryText` 派生的 `resultSummary`）在名称下方用一行灰字（`text-ui-sm text-foreground-subtle`、单行截断、`title` 给全文）"原因：…"；没有摘要时只显示状态文字。
- 停止：成员可停时（规则同"停止"）行尾显示一个 `icon-xs` ghost 停止按钮（方块图标，无障碍名称"停止 {name}"），点击不冒泡到行；不可停或只读会话不显示。不再提供"停止全部"。
- 不在行内显示模型、档位、步骤数或任务摘要；这些信息在右侧详情头部（模型）与子会话正文中查看。
- 窄宽度（≤ 390px 容器）下名称先截断，类型标签与状态文字不换行、不溢出；停止按钮不收缩。

### 折叠

- 行组本身不可折叠，不再有"N 个 Subagent 已完成"摘要行，也不再写 conversation-presentation disclosure override。
- 与完成轮次的「已工作 N 秒」折叠的关系（UX08，SAT31）：含活动成员或失败成员的行组提升到历史摘要之下，其余工作项仍折叠；历史展开时回到原位置。全部成功结束的行组回到历史折叠内。
  - 修复依据：父 Agent 派出后台子智能体后本轮结束，工作卡被折进「已工作 N 秒」，而状态胶囊仍显示"1 个运行中"，用户看不到正在工作的子智能体，违背"subagent 可视化清晰易懂"。

### 停止

- 单个停止：只在父会话 `backgroundWorks` 精确匹配可停 work（`kind=subagent`、`status=running`、唯一 `childSessionId`、`cancellable !== false`）且成员仍在运行时出现；规则与详情头部共用 `resolveSubagentStopWorkId`，命令为既有 `cancelBackgroundWork(workId)`。
- 停止只经过宿主注入的 `onCancelBackgroundWork`；只读会话不注入，行上即没有停止。

### 交互

| 点击对象 | 条件                                   | 结果                                                                                      |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| 成员行   | 有 `childSessionId` 且宿主提供打开能力 | 通过既有 `onOpenSubagentSession` 打开（或激活）右侧唯一"子智能体"Tab 并直接进入该成员详情 |
| 成员行   | 尚未登记子会话                         | 无动作（按钮禁用，状态"等待启动"）                                                        |
| 停止     | 可停                                   | `cancelBackgroundWork(workId)`；事件不冒泡到成员行                                        |

- 成员行无障碍名称包含名称、状态和动作；有子会话的成员行携带 `v4-subagent-open-side-pane-<childSessionId>`，每个子会话只有一个直开入口；未登记成员携带 `v4-subagent-work-card-member-<toolCallId>`；行组容器保留 `v4-subagent-work-card-<rowId>` 与 `data-state=running|ended`。

### 旧派发行（无子会话的兜底）

- 一行文字："A、B 和 C 开始工作" / "A, B, and C started working"。名称列表用 `Intl.ListFormat(locale, { type: "conjunction" })`，每个名称前带 16px 头像。
- 名称 = 工具调用的标题/描述 → `subagentType` → 本地化"智能体 N"（N = 序号 + 1）。
- 每个名称后用图标表示终态：完成为对勾、失败为叉（危险色，伴随无障碍文字）、已停止为禁止符号；运行中不加旋转图标。行尾显示状态计数，有成员运行时计数文字使用运行扫光。
- 点击名称展开本行，并展开该智能体卡的行内详情；行尾箭头切换显示原有的逐个 Agent 卡；展开状态只存于 Renderer 内存。

## 右侧"子智能体"Tab（YCode 1.4）

- 每个 root 会话在右侧只有**一个**"子智能体"Tab（类型 `subagent-directory`，身份 `subagent-directory:{workspaceKey}:{rootSessionId}`）。Tab 内有两个视图：目录（默认）与某个子智能体的详情；不再为每个子智能体新开 Tab，也不再创建新的 `subagent-session` Tab。
- 视图状态只存在 Tab 上的可选选择字段（`childSessionId`、`subagentType`、`title`），是 Renderer 侧栏内存状态，不写入 session、store 或协议；`parentSessionId` 为当前目录所属父会话（嵌套子智能体时为其直属父会话）。
- 打开规则（唯一写入路径为 `workspaceSidePane.ts`）：
  - 时间线成员行、状态面板运行项、目录项、嵌套子会话内的 Agent 卡 → `openSubagentSessionSidePane`：打开或激活该 root 的"子智能体"Tab 并选中该子智能体（详情视图）；同 root 已有的旧 `subagent-session` Tab 被并入并关闭。
  - 状态面板"已结束 · N"、输入区子任务汇总 → `openSubagentDirectorySidePane`：打开或激活同一 Tab 并清除选择（目录视图）。
  - 详情左上角返回箭头 → 同 `openSubagentDirectorySidePane`，回到该父会话目录。
- edit/retry 使选中的子会话失效时（`syncSubagentSessionSidePaneTabs`），只清除选择回到目录，不关闭 Tab。
- Tab 条：Bot 图标 + "子智能体" / "Subagents"。

```mermaid
sequenceDiagram
  participant T as 时间线行 / 目录项 / 状态面板
  participant P as workspaceSidePane（Tab 唯一 owner）
  participant V as "子智能体"Tab 视图
  T->>P: openSubagentSessionSidePane(child)
  P->>P: 找到同 workspace+root 的目录 Tab（无则创建），写入选择，合并旧 child Tab
  P->>V: 详情视图（childSessionId）
  V->>P: 返回 → openSubagentDirectorySidePane(parent)
  P->>V: 清除选择 → 目录视图
```

### 详情视图

- 头部：左侧返回箭头（`icon-sm` ghost，无障碍名称"返回子智能体目录"）+ 24px 头像 + 名称 + 状态（图标与文字）+ 耗时；右上角模型标签（有 `model` 时，`effort` 附在其后）+ 停止按钮（可停时）。模型取父会话 `running[]` 中该子会话的项；不在运行中时取父时间线中该子会话最后一个 `subagent` 行；都没有则不显示。
- 状态：父会话 `running` 中有该子会话时取其 `running` / `waiting` / `blocked`；否则取子会话 `control`：`completedSuccess` → 已完成，`completedInterrupted` → 已停止，`error` 或存在 `lastError` → 失败，`running` / `prewarming` → 运行中。
- 耗时：运行中按父会话 `startedAt` 每秒刷新；结束后在子会话行窗口已到顶时取首个 `turnHeader.startedAt` 到最后一个 `endedAt`，否则不显示。
- 停止按钮只在父会话 `backgroundWorks` 精确匹配可停 work 时出现，发送父会话 `cancelBackgroundWork(workId)`，被拒绝时记 warn 日志。它是父会话的后台控制，不是子会话的停止，子会话仍保持只读。
- 底部：子会话只读，原输入区位置显示一行提示"子智能体由主智能体驱动，无法输入。"（i18n `subagentDisplay.sidePane.readOnlyHint`）。
- 记录区复用只读 `SessionPane`，通过同一 session lease 实时更新；切换选中的子智能体时按 `childSessionId` 重挂详情。
- 适用于任意 `childSessionId`，不读取引擎类型。

### 目录视图

- 复用 `SubagentDirectorySidePane`：运行中 · N（不分页）/ 已结束 · N（每页 20，"再显示 20 个"），每行 20px 头像（序号取父会话清单，变体取 `subagentType`）、名称、状态图标 + 文字、摘要与相对时间；点击行进入该子智能体详情（同一 Tab）。
- 桌面、普通 Web 与手机 Web 一致：手机 `/remote` 抽屉中的同一 Tab 也可经返回箭头进入目录；已结束分页查询不可用时显示既有"无法加载"提示，运行中分区仍来自投影。

## 引擎无关合同（M2-B 映射要求）

外部引擎子智能体映射完成后，UI 不需要任何引擎分支即可得到完整展示，前提是 CLI 提供：

1. 子会话以 `taskType=subagent_child` 持久化后才发布派发；父会话 `snapshot.subagents.childSessionIds` 按派发顺序追加，同一分支内不重排。
2. `running[]` 项带原生类型 `subagentType`（如 Claude Code 的 `subagent_type`、Codex 的角色名）、任务描述 `title`、`status` 与 `startedAt`；子会话权限请求进入父会话待处理交互并标注 `origin.kind=subagent`，使该项显示为 `waiting`。
3. 父时间线保留 Agent/Task 工具行，并有 `parentToolCallId` 指向它、带 `childSessionId` 的 `subagent` 行，用于配对。
4. 只有引擎支持停止时才发布带 `childSessionId` 的 `backgroundWorks` 项；不支持时不发布或 `cancellable=false`，UI 即不显示停止。
5. 子会话 snapshot 提供 `control.phase` 与 `turnHeader` 行；缺失时详情头部只显示能确认的字段。
6. （W8，可选）`subagent` 行与 `running[]` 项可带 `model`（展示用模型 ID，不含 provider 前缀）、`effort`（思考档位原值）、`toolCallCount`（子智能体本次运行已发起的工具调用数）。来源：
   - 内置引擎：`model` / `effort` 取 `SubagentSpawned` 载荷（子智能体 profile 显式指定模型时才有；继承父模型时不发）；`toolCallCount` 由父会话投影在丢弃镜像子工具事件（`source=subagent`）前按子工具调用 ID 去重计数，`SubagentStopped.totalToolUseCount` 到达时以它为准。镜像事件不落库，CLI 冷启动后运行中成员的计数从未知开始，结束时由 `totalToolUseCount` 校正。
   - 外部引擎：不知道子智能体模型时不发 `model` / `effort`；`toolCallCount` 由 `core/src/external-engine/subagents.ts` 在写子会话工具行时计数，实时以 `source=subagent` 的镜像 `ToolCallScheduled` 通知父会话（不落库），结束时写入 `SubagentStopped.totalToolUseCount`。
   - 恢复（resume）开启新一次运行时，计数从头开始。

```mermaid
sequenceDiagram
  participant RT as CLI 子智能体运行（内置 runner / 外部 subagents.ts）
  participant P as CLI 父会话 ProductProjection（唯一所有者）
  participant U as Renderer 工作卡 / 详情头部
  RT->>P: SubagentSpawned{model?, effort?}（落库）
  P->>U: subagent 行 + running[] 带 model/effort
  loop 每个子工具调用
    RT->>P: 镜像 ToolCallScheduled{source=subagent, agentId}（仅实时，不落库）
    P->>P: 按子工具调用 ID 去重，toolCallCount += 1，不产生父时间线工具行
    P->>U: row.upserted（subagent 行）+ running[] 更新
  end
  RT->>P: SubagentStopped{totalToolUseCount}（落库）
  P->>U: 终态行，toolCallCount = totalToolUseCount
  U->>P: 停止 / 停止全部：逐个 cancelBackgroundWork(workId)（幂等）
```

未满足 1–3 的旧会话（当前 Claude Code 行内兜底）仍按"无子会话"规则显示：临时序号、点击展开行内详情。

引擎覆盖：内置引擎完整支持；Claude Code 实时显示，有 `capabilities.cancel` 时可停（后台子智能体在父轮结束后不再观测，沿用已知限制）；Codex 实时显示、不可停（R2-4），行上与详情头部都没有"停止"。

## 验收场景

| ID   | 前置                                                          | 操作                           | 期望                                                                                                            |
| ---- | ------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| MA01 | 同一轮并行派发 3 个 Explore / Plan / general-purpose 子智能体 | 观察时间线                     | 三行子智能体行（无外框），头像依次为九色板前三色，轮廓分别为天线、护目镜、基础，运行中头像动态                  |
| MA02 | MA01 运行中，另有进行中的 todo 和 Git 变更                    | 观察收起胶囊                   | 显示 3 个头像与"3 个运行中"；有运行中的工作流时工作流优先                                                       |
| MA03 | 7 个并行子智能体运行中                                        | 观察胶囊；点击胶囊             | 只显示 3 个头像与"7 个运行中"；面板展开且"智能体"分区打开                                                       |
| MA04 | MA01                                                          | 点击 B 的行                    | 右侧打开唯一"子智能体"Tab 并进入 B 的只读实时对话；头部有返回箭头、同色同轮廓头像、名称、运行中、耗时与模型标签 |
| MA05 | 外部引擎行内兜底，两个相邻派发无子会话                        | 点击第二个名称                 | 本行展开，第二个 Agent 卡行内详情展开；不打开右侧面板                                                           |
| MA06 | 两个派发之间夹一段正文或另一工具                              | 观察时间线                     | 不合并，各自显示子智能体行（无子会话时各自为 Agent 卡）                                                         |
| MA07 | MA01 全部完成后刷新 Renderer 并冷启动 CLI                     | 重新打开会话                   | 三行均显示"已完成"，头像颜色与轮廓不变                                                                          |
| MA08 | 后台子智能体可停、前台不可停                                  | 打开两者详情                   | 只有后台的头部显示停止；点击后父会话收到 `cancelBackgroundWork`                                                 |
| MA09 | 系统开启减少动态效果                                          | 打开运行中详情                 | 头像不播放空闲动作，表情仍按状态显示                                                                            |
| MA10 | 浅色/深色主题、390px 与 1200px 容器、中文/英文                | 观察胶囊、子智能体行、详情头部 | 文字不溢出胶囊与卡片，按钮不收缩，头像对比清晰                                                                  |
| MA11 | 内置引擎派发 1 个带模型 profile 的 explorer，运行中           | 观察行；点击行                 | 行显示名称、类型标签与"运行中 · 用时"（每秒刷新）；详情头部右上角显示模型 + 档位                                |
| MA12 | 1 个可停后台子智能体 + 1 个不可停前台子智能体运行中           | 点击可停行的停止               | 只对可停成员发一次 `cancelBackgroundWork`，不打开详情；不可停成员行没有停止                                     |
| MA13 | Codex 引擎派发子智能体                                        | 观察行                         | 实时显示状态；没有停止；详情头部没有模型标签                                                                    |
| MA14 | MA11 运行中                                                   | 点击成员行；子智能体继续工作   | 右侧打开只读子会话，正文实时增长，头部有模型标签，底部显示只读提示；不自动打开                                  |
| MA16 | 依次点击时间线中的 A 与 B，再点详情返回箭头                   | 观察右侧 Tab 条与内容          | 只有一个"子智能体"Tab；先后显示 A、B 详情；返回后显示目录（运行中 · N / 已结束 · N），点目录项再次进入详情      |
| MA15 | 父 Agent 派出后台子智能体后本轮结束，子智能体仍在运行         | 观察时间线；子智能体全部结束   | 轮次显示「已工作 N 秒」并收起其它工作项，子智能体行仍可见于摘要之下（运行中、可点开右栏）；结束后只保留失败行组 |

单测覆盖序号派生、变体映射、列表格式、分组、胶囊优先级、详情头部模型、派发行点击、子智能体行（分组、名称/类型标签、计时、失败原因、单行停止、运行中豁免轮次折叠）与单一子智能体 Tab（打开即选中、返回目录、合并旧 child Tab、失效回目录）；交互场景以待人工 review 的 E2E 覆盖（`manual-review/pending/conversation-session-multi-agent-display.test.ts`、`manual-review/pending/conversation-session-subagent-work-card.test.ts`、`manual-review/pending/conversation-session-subagent-side-tabs.test.ts`）。Case catalog 对应 SAT31–SAT34。

## 2026-11-11 桌面体验修订

> 1.4 起工作卡外框、折叠与"停止全部"退役（见"对话行内子智能体行"），本节关于卡片折叠、"结果：/查看结果"的描述只适用于 1.3 历史版本；名称规则、输入区汇总与生命周期收敛规则仍有效。

运行与结束阶段共用手动展开偏好；生命周期仅派生默认态，不能覆盖正在查看的内容。

可见名称统一按任务标题/描述优先、非通用类型其次、编号兜底；类型只作辅助信息。运行卡默认展开，允许主动折叠，折叠后显示真实运行/等待/阻塞及结束计数，失败和停止不算成功。成功成员显示“结果：{summary}”和“查看结果”，无摘要显示“已完成，可查看过程”；失败保留“原因：{summary}”。输入工具栏只在存在活动成员时显示汇总（复用 pending/running/waiting/blocked 判定），全部结束即退场，不关闭详情、不停止或取消运行，历史和目录保留。不得从 Agent 工具启动 ACK 或父轮完成推断子任务完成。终态沿 CLI 唯一生命周期投影收敛，旧执行事件不能覆盖新执行。

```text
CLI 唯一生命周期 → 父 manifest / subagent 行 → Renderer 派生活动汇总
                                      ├─ 最后活动成员结束 → 输入区汇总退场
用户打开详情 → 既有 Side Pane tab owner ┴─ 保留只读详情
用户手动折叠 → disclosure override → 卡片与相关外层历史共同读取
```

输入区目录入口只计算已登记 manifest 成员：协议 running[] 当前仅有 running/waiting/blocked；尚未登记 child 的 pending 在主对话工作卡按既有 helper 保持活动和默认展开，不提前显示空目录、不扩协议或生成 child 身份。代价是登记前输入区不提前计数。

执行代次由 Spawn 的 parentToolCallId 派生，独立于原 Agent 行的显示锚点。携带执行身份的迟到 Stop/后台终态不得覆盖新一次执行；缺失身份的历史事件保留兼容。该索引仅属于 CLI 投影并由事件重放重建。
