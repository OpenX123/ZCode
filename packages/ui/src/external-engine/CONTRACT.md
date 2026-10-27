# 外部引擎 UI

会话创建前由已有 Composer 草稿保存 engine 选择；创建后只读 snapshot.config.engine。
创建后的输入框仅用固定小尺寸灰色 Logo 标识引擎，复用 TaskClientLogo 的可访问名称和悬停标题，不提供切换动作；草稿继续使用引擎选择器。
历史会话行经公开 TaskClientLogo 消费 CLI 镜像的 task.engine，缺省使用应用自有 Logo；图标为本地资源，无网络请求或状态写入。
引擎配置来自 snapshot.config.engineConfigOptions，选择原样回传 setEngineConfigOption。
组件经 hooks/external-engine 访问可选 Host 服务，服务缺失或远程 workspace 隐藏入口。
未就绪拒绝不清空草稿；安装只能由设置页按钮触发，官方登录命令只展示给用户执行。

设置页使用独立 `agentEngines` 分区，紧随模型设置；导航可见性由本地 Host 服务能力决定。
模型页不挂载引擎检测。未就绪引导直达独立分区，上次停留位置复用既有设置导航偏好。
引擎列表默认展示就绪、版本与登录状态；包名折叠到技术详情，复制登录命令不执行命令。

运行中原生配置保持可调，仍复用串行配置屏障与 snapshot 确认值；连接未就绪时禁用，配置拒绝可见提示且保留原值。

上下文用量直接复用 snapshot.usage 与 ChatContextUsage；子 Agent 过程通过现有工具卡按 parentToolCallId 嵌套，无实际 childSessionId 时不展示下钻入口。

历史会话的连接状态和配置均只读 snapshot：connecting 显示加载，error 显示失败和重新连接；未就绪时原生配置不可写，草稿仍可编辑。重试通过 V4 配置 CAS 命令 prepareExternalEngineSession。
