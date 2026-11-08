# 外部引擎 UI

会话创建前由已有 Composer 草稿保存 engine 选择；创建后只读 snapshot.config.engine。
本机 AppSettings.defaultSessionEngine 只给后续全新草稿提供种子；种子读取完成前不预热。输入框显式改选与独立设置页默认选择共用本机设置写入，其他窗口通过 SettingsChanged 刷新，旧草稿及已有会话不改写。
工作区没有引擎服务（远程工作区、Web）时草稿使用 YCode，不写回默认偏好；桌面远程工作区的草稿选择器保留，外部引擎经 `externalEngineUnavailableReason` 灰显并就地说明原因。
`hooks/external-engine` 的 `useEngineConfigMemory` 按引擎记忆 snapshot 确认的显式模型与思考深度（`engineConfigOptionKind` 判定，权限模式不记），写本机 AppSettings.externalEngineConfigPreferences 增量；只对本生命周期新固定外部引擎的草稿，在预热会话原生配置 ready 后经既有 setEngineConfigOption 链路按目录恢复一次（模型先于深度）；逐项推进以 ACK 带回的确认配置为准，引擎改用其它值或保留旧值即停止。
2026-11-08 起草稿不显示“正在连接引擎…”：creating（owner `pending`）与 connecting 阶段经 `configPending` 只把原生配置选择器显示为禁用，引擎与连接配置仍可改选，发送入口可用；首发由 SessionPane 发送链等待就绪与 `useEngineConfigMemory.waitForRestore` 收口后才 `sendText`。预热只在 pane 首次可见后启动。`loading`（连接中文案）只用于已有会话。
创建后的输入框仅用固定小尺寸灰色 Logo 标识引擎，复用 TaskClientLogo 的可访问名称和悬停标题，不提供切换动作；草稿继续使用引擎选择器。
历史会话行经公开 TaskClientLogo 消费 CLI 镜像的 task.engine，缺省使用应用自有 Logo；图标为本地资源，无网络请求或状态写入。
引擎配置来自 snapshot.config.engineConfigOptions，选择原样回传 setEngineConfigOption。模型与普通枚举菜单复用共享下拉层的可用高度、视口宽度和纵向滚动，保持目录顺序且菜单不越出视口，所有选项均可滚动到达并点击。
组件经 hooks/external-engine 访问可选 Host 服务；Web 等无本机服务的 Host 隐藏入口，远程 workspace 的草稿灰显外部引擎。
未就绪拒绝不清空草稿；安装只能由设置页按钮触发，官方登录命令只展示给用户执行。

设置页使用独立 `agentEngines` 分区，紧随模型设置；导航可见性由本地 Host 服务能力决定。
模型页不挂载引擎检测。未就绪引导直达独立分区，上次停留位置复用既有设置导航偏好。
引擎列表默认展示就绪、版本与登录状态；包名折叠到技术详情，复制登录命令不执行命令。

运行中原生配置保持可调，仍复用串行配置屏障与 snapshot 确认值；连接未就绪时禁用，配置拒绝可见提示且保留原值。
深度滑块提交后保持局部所选位置直到确认配置回流，避免释放瞬间回跳；onConfigChange 可返回 Promise<boolean>，false 或拒绝时撤销该次局部显示。局部显示不写入 snapshot，不覆盖新目录或新确认值；较早请求失败不得清掉后续手势。

上下文用量直接复用 snapshot.usage 与 ChatContextUsage；子 Agent 过程通过现有工具卡按 parentToolCallId 嵌套，无实际 childSessionId 时不展示下钻入口。

历史会话的连接状态和配置均只读 snapshot：connecting 显示加载，error 显示失败和重新连接；未就绪时原生配置不可写，草稿仍可编辑。重试通过 V4 配置 CAS 命令 prepareExternalEngineSession。

2026-11-07 连接配置：设置页每个引擎下列出连接配置（名称、方式、网关、默认标记），新建、编辑、删除、设为默认均调用 Host `updateConnectionProfiles` 并以返回视图为准；`useEngineConnectionProfiles` 只缓存视图并订阅 `onConnectionProfilesChanged`，不做乐观改写。测试连接经 Host `testConnection`（需本地 workspace），可取消。输入框草稿通过 `useEngineConnectionControl` 选择配置：选择后 Host 记录上次使用，草稿 owner 重建预热并在 createSession 携带 `engineConnectionProfileId`；绑定事实只读 snapshot `config.engineConnectionProfileId`，已创建会话只读显示非缺省绑定。
