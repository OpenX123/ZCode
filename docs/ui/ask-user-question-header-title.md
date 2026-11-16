# AskUserQuestion 移动端问题弹窗展示

## 背景

AskUserQuestion / elicitation 面板头部为了保持紧凑曾单行截断问题文本，并通过 hover title 兜底。该方式在桌面端可勉强查看完整内容，但移动 Web 远控没有 hover，用户会直接感知为“问题显示不完全”。

移动端进一步存在视口高度不足的问题：长问题和多选项会占据大半屏，用户需要临时查看上下文时，不能只能通过提交或忽略来关闭阻塞问题弹窗。

## 方案

- 面板问题区采用 `<tag> <question>` 顺序：tag 在前，question 紧随其后。
- 桌面端 question 不单行截断，必须自然换行展示完整文案。
- 移动端长 question 默认限制为 4 行，并提供“展开问题 / 收起问题”按钮；展开后可完整阅读题干。
- 移动端弹窗整体提供“折叠问题弹窗 / 展开问题弹窗”按钮。折叠后只保留紧凑摘要行、题号和展开按钮，隐藏选项区与底部动作，方便用户查看上下文。
- 整体折叠只影响当前客户端 UI 状态，不响应、不取消、不修改 AskUserQuestion 请求；用户重新展开后继续使用原选项和草稿。
- question 文案使用 `leading-6`，保证长问题换行后有足够行间距；选项答案文案保持紧凑高度。
- 问题正文仍保留原生 `title`，作为桌面端复制/hover 的辅助能力，但不能作为唯一完整阅读路径。
- 长 header 仍可在顶部用 Badge 紧凑展示，避免挤压翻页控件。
- 选项文案按自然阅读顺序展示：标题在前，描述紧随其后。文案区域不使用 flex 布局，避免标题和描述被分散到不符合阅读顺序的位置。
- 该能力不改变 AskUserQuestion 的协议、回答内容、任务流或 remote replayable/desktop continuous 语义。

## 显式发送与会话归属（UX07）

- 普通 Ask 问题卡固定在所属会话 composer 上方；双栏各自渲染，非焦点栏不抢键盘焦点。
- “上方”沿用 [v4 protocol §4.2.6](../v4-refactor/10-protocol-spec.md) 的同一 sticky bottom dock 与 DOM 顺序：interaction 在 composer 节点之前。pending 期间普通 composer 保持挂载，以 `aria-hidden` / `display:none` 隐藏，保留原编辑器、草稿和附件；问题卡收起时也不开放另一个普通发送入口。代价是收起后只能阅读上下文并重开作答，普通输入在权威 pending 清场后恢复。
- 单选、多选的点击、数字键、空格或选项上的 Enter 仅修改本地草稿，不切题、不发送。
- 下一题仅导航，上一题可修改原答案；导航不得把仅有焦点的选项伪造成答案。最后一题明确点击或键盘激活“发送”后，才通过既有 onRespond 提交一次。
- 普通自定义多行输入的 Enter（含 Ctrl/Meta+Enter）保留编辑语义；IME 确认候选不导航、不发送。Tab 可以走到显式下一题/发送按钮，只有该按钮获得焦点后的 Enter 才执行其动作。
- 普通 Ask 显式收起、重开及 Escape 收起按首次真实 navigation 沿既有 snooze 路径暂停自动继续；同一请求去重。隐藏后不会继续旧的无人操作倒计时，可能等待用户更久；不新增 timer 或状态 owner。审批的 dismiss 与超时不受此规则影响。
- 所有屏幕尺寸均提供收起入口；关闭/Escape 仅收起问题卡，显示“等待回答”与重新打开入口，不回答、不 decline，并保留题号和全部草稿。独立“跳过”仍沿既有 decline 路径。
- 本地草稿由既有会话 UI store 保存，按 workspaceIdentity fallback workspacePath、remoteSessionId、session/task、trace、request 的完整身份恢复；同请求 snapshot 重建、收起重开、切换任务不丢进度，新身份不得继承旧草稿。本地 remoteSessionId 缺省路径继续可用；无完整身份的历史草稿仅沿本地缺省路径兼容。
- runtime 的 pending interaction 是唯一请求事实。另一端先完成后，本地迟到回调不得重新发送，也不得解答后续请求；不新增队列。保持 workspaceIdentity、remoteSessionId 与 owner/lease 路由。
- 发送中的同步重复激活由组件与既有 V4 flight 门禁拦截；既有 resolveInteraction ACK 接受后保持防重，等待权威 pending 清场。明确拒绝或传输失败时释放同身份门禁，保留草稿供用户显式重试；不能把一次失败当作请求已完成，也不新增自动重试或延时。
- 普通权限和 ExitPlanMode 保持原独立确认、拒绝及超时语义，不能被普通 Ask 的显式发送规则改写。

```text
选项/输入/导航 → 会话本地草稿（不提交）→ 最后明确发送 → 既有 resolveInteraction → runtime 首次有效响应
                    │                         │                             │
               收起/重开保留             完整身份及一次性门禁                 └─ pending 移除
                    └──── 同身份 snapshot 保留；不同身份初始化 ──── 迟到响应丢弃 ──┘
```

## 验收

- 长问题在桌面端无需 hover 即可完整阅读；移动端可通过“展开问题”完整阅读。
- tag 与 question 按顺序展示，question 不使用 `truncate`。
- question 使用 `leading-6`，选项标题和选项描述不被 question 行距调整影响。
- 翻页控件不被长问题挤压。
- 选项标题和描述在同一个文本流中展示，描述跟在标题后自然换行。
- 移动端可以折叠整个问题弹窗，并在折叠摘要里重新展开，不影响任务流或回答草稿。
- SSR 输出中包含完整问题的可见正文和 `title` 属性，避免后续回归。
- 真实键盘选择、输入与多题回改均不产生模型续轮；显式发送一次后，续轮包含最终草稿。
- 收起重开、snapshot 重建、双栏焦点、IME 和另一端先完成的迟到提交均有回归覆盖；权限和计划审批规则独立。
