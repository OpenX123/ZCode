# 外部引擎 UI

2026-11-09 W1/W2/R2-1 Composer：输入区上方不再有引擎胶囊（`placement`/`engineSelector` 已删除）。SessionPane 构建唯一的 `EngineSwitchRow` 节点（新草稿 + 本地工作区可切换、已有会话只读、远程/Web 不传），经 `EngineControls.engineSwitchRow` 与 `ConversationComposer.engineSwitchRow` 分别挂到外部引擎弹层和 YCode 模型弹层顶部，选择仍走 `handleSelectEngine`。输入区不显示任何连接入口或标签，Host 连接配置、lastUsed 与不可变绑定不受展示影响。底部左侧只有附件与权限（`engineConfigOptionPlacement` 为 `primary-mode`，即 id `mode`）；右侧单个入口（14px 引擎图标 + 档位/模型文案）打开弹层：切换行 → `[⚡] 模型 档位 ›` 头部行 → 去掉 `default` 档的本地化滑杆 → 「更多选项」。Fast 类（归一化 id fast/fastmode/speed/servicetier 且取值恰为 on/off 类两项）为闪电开关，点亮=开启；`default` 模型别名显示 description 解析出的真实名 + 「默认」，不显示 adapter 名称。`renderLayout` 只把同一 EngineControls 的 leadingActions/modelControls 节点交给 Composer，不创建第二份 activePicker 或模型事实。模型/深度读 snapshot，选择沿原屏障提交，确认/拒绝/迟到 ACK 规则不变。偏好按 engine/profile 增量合并；legacy 仅初始化兼容。 原始配置 ID/value 贯穿提交，打开弹层零写入，被拒绝时仍读 snapshot 确认值；深度为空时仍可访问其他有效项。

恢复开始后的断连由 memory owner 终结本轮并拒绝当前等待，旧 ACK 不再推进；同一绑定重连后下一次等待可收口，不创建新 owner 或超时放行。

会话创建前由已有 Composer 草稿保存 engine 选择；创建后只读 snapshot.config.engine。
本机 AppSettings.defaultSessionEngine 只给后续全新草稿提供种子；种子读取完成前不预热。输入框显式改选与独立设置页默认选择共用本机设置写入，其他窗口通过 SettingsChanged 刷新，旧草稿及已有会话不改写。
工作区没有引擎服务（远程工作区、Web）时草稿使用 YCode，不写回默认偏好；引擎切换行不渲染（W2 起不再灰显说明，`externalEngineUnavailableReason` 已删除）。
`hooks/external-engine` 的 `useEngineConfigMemory` 按引擎与连接记忆 snapshot 确认的显式模型、思考深度与权限模式（`isRememberableEngineConfig` 判定，计划类模式不记；2026-11-09 起），写本机 AppSettings.externalEngineConnectionConfigPreferences 增量，旧 externalEngineConfigPreferences 仅兼容读取；只对本生命周期新固定外部引擎的草稿，在预热会话原生配置 ready 后经既有 setEngineConfigOption 链路按目录恢复一次（模型 → 深度 → 模式；该引擎 + 连接的有效记忆没有思考深度项时按项默认深度 high（与模型/模式记忆无关，按恢复到该项时的目录判断），只下发不写记忆）；逐项推进以 ACK 带回的确认配置为准，引擎改用其它值或保留旧值即停止。
2026-11-08 起草稿不显示“正在连接引擎…”：creating（owner `pending`）与 connecting 阶段经 `configPending` 只把原生配置选择器显示为禁用，引擎仍可改选（连接在设置页管理），发送入口可用；首发由 SessionPane 发送链等待就绪与 `useEngineConfigMemory.waitForRestore` 收口后才 `sendText`。预热只在 pane 首次可见后启动。`loading`（连接中文案）只用于已有会话。
创建后的会话在模型入口弹层顶部只读显示当前引擎（TaskClientLogo + 名称），不提供切换动作；入口按钮本身显示 14px 引擎图标。
历史会话行经公开 TaskClientLogo 消费 CLI 镜像的 task.engine，缺省使用应用自有 Logo；图标为本地资源，无网络请求或状态写入。
引擎配置来自 snapshot.config.engineConfigOptions，选择原样回传 setEngineConfigOption。模型与普通枚举菜单复用共享下拉层的可用高度、视口宽度和纵向滚动，保持目录顺序且菜单不越出视口，所有选项均可滚动到达并点击。
组件经 hooks/external-engine 访问可选 Host 服务；Web 等无本机服务的 Host 与远程 workspace 均隐藏引擎切换行。
未就绪拒绝不清空草稿；安装只能由设置页按钮触发，官方登录命令只展示给用户执行。

设置页使用独立 `agentEngines` 分区，紧随模型设置；导航可见性由本地 Host 服务能力决定。
模型页不挂载引擎检测。未就绪引导直达独立分区，上次停留位置复用既有设置导航偏好。
引擎列表默认展示就绪、版本与登录状态；包名折叠到技术详情，复制登录命令不执行命令。

运行中原生配置保持可调，仍复用串行配置屏障与 snapshot 确认值；连接未就绪时禁用，配置拒绝可见提示且保留原值。
深度滑块提交后保持局部所选位置直到确认配置回流，避免释放瞬间回跳；onConfigChange 可返回 Promise<boolean>，false 或拒绝时撤销该次局部显示。局部显示不写入 snapshot，不覆盖新目录或新确认值；较早请求失败不得清掉后续手势。深度目录为空时仅禁用深度滑块；合并弹层内仍有模型或 Fast 控件时保持入口可用，打开不写配置，选择仍回传原始值。

上下文用量直接复用 snapshot.usage 与 ChatContextUsage；子 Agent 过程通过现有工具卡按 parentToolCallId 嵌套，无实际 childSessionId 时不展示下钻入口。

历史会话的连接状态和配置均只读 snapshot：connecting 显示加载，error 显示失败和重新连接；未就绪时原生配置不可写，草稿仍可编辑。重试通过 V4 配置 CAS 命令 prepareExternalEngineSession。

2026-11-07 连接配置：设置页每个引擎下列出连接配置（名称、方式、网关、默认标记），新建、编辑、删除、设为默认均调用 Host `updateConnectionProfiles` 并以返回视图为准；`useEngineConnectionProfiles` 只缓存视图并订阅 `onConnectionProfilesChanged`，不做乐观改写。测试连接经 Host `testConnection`（需本地 workspace），可取消；2026-11-09 起成功显示「测试通过」，结果的可选 `warnings` 用警告色逐条列出。草稿继续通过 `useEngineConnectionControl` 取得连接事实并保留原选择接口；Composer 不展示连接入口。设置页选择后 Host 记录上次使用，草稿 owner 重建预热并在 createSession 携带 `engineConnectionProfileId`；绑定事实只读 snapshot `config.engineConnectionProfileId`，已创建会话绑定继续只读 snapshot，输入区不展示连接标签。

2026-11-09 ACP 管理页：结构化检查为可选安全投影，认证/路由按 connectionProfileId 隔离，ready 仅为运行环境可用。配置先读、所选引擎独立诊断；查看不写上次使用，编辑 Dialog 沿用新 ID 保存与旧绑定。管理检查/安装支持按引擎取消，登录/测试沿用既有取消；详见 external-agent-engines-spec.md「设置诊断接口与取消边界」。
